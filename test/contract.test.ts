// Behavioral contracts, asserted through the plugin's public hooks.
//
// The other suites test the pieces: policy.ts in isolation, the status wire
// shape, the usage ledger's invariants. This file tests the promises the README
// and the module comments make to a USER, end to end through
// tool.execute.before / tool.execute.after / event, because that is the surface
// a regression would actually reach:
//
//   1. Instrumentation is never a new failure mode. A throwing audit, a
//      throwing toast, or an unmeasurable session must not fail a tool call.
//      This is the one promise whose violation is strictly worse than not
//      having the plugin at all.
//   2. Recovery is observable. current falls, peak holds, and the
//      recommendation follows peak because the money is already spent.
//   3. block mode has exactly one escape hatch and it always works.
//
// The existing suites already cover boundary dedupe per message id, the
// 60/120 audit cadence, one-block-per-call composition, and pause-gated
// handoff arming; those are not duplicated here.

import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/core/log.js", () => ({ log: vi.fn(), logConfigDiagnostics: vi.fn(() => []) }))
vi.mock("../src/core/audit.js", () => ({ runAudit: vi.fn(() => "effective fresh tokens: 1k") }))

import { runAudit } from "../src/core/audit.js"

const ENV_KEYS = [
  "TOKEN_NORM_MODE",
  "TOKEN_NORM_MAX_COST",
  "TOKEN_NORM_MAX_EFFECTIVE_TOKENS",
  "TOKEN_NORM_MAX_TOOL_CALLS",
  "TOKEN_NORM_CONTEXT_WARN",
  "TOKEN_NORM_CONTEXT_LIMIT",
  "TOKEN_NORM_ANNOUNCE_AT",
  "TOKEN_NORM_AUDIT_EVERY",
  "TOKEN_NORM_BOUNDARY_AT",
]

async function freshPlugin(env: Record<string, string> = {}, client?: unknown): Promise<any> {
  vi.resetModules()
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  const mod = await import("../src/session-budget.js")
  return mod.SessionBudgetPlugin({ client } as never)
}

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

/** Returns the tool's output text so a test can assert on what was injected,
 * and throws only if the plugin itself throws -- which is the failure these
 * tests exist to catch. */
async function toolCall(h: any, sessionID: string, tool = "read", args: any = {}): Promise<string> {
  const output = { title: "t", output: "tool output", metadata: {} }
  await h["tool.execute.after"]({ tool, sessionID, callID: "c", args }, output)
  return output.output
}

async function stepFinish(h: any, sessionID: string, id: string, cost: number, tokens: any): Promise<void> {
  await h.event({
    event: { type: "message.part.updated", properties: { part: { type: "step-finish", id, sessionID, cost, tokens } } },
  })
}

async function status(h: any, sessionID: string): Promise<any> {
  return JSON.parse((await h.tool.token_norm_status.execute({}, { sessionID } as never)).output)
}

const gate = (h: any, sessionID: string) => (tool: string) =>
  h["tool.execute.before"]({ tool, sessionID, callID: "c" }, { args: {} })

// mockReset, not mockClear: one test below replaces runAudit with a throwing
// implementation, and mockClear would leave that implementation in place for
// every test after it.
beforeEach(() => {
  vi.mocked(runAudit).mockReset()
  vi.mocked(runAudit).mockReturnValue("effective fresh tokens: 1k")
})

describe("contract: instrumentation never fails a tool call", () => {
  it("survives an audit that throws instead of returning its own error text", async () => {
    // runAudit is written to swallow everything and return a message. If that
    // contract is ever broken upstream -- a new throw before the try, a
    // rewrite -- the tool call must still succeed, because the audit is a
    // checkpoint and the tool call is the user's actual work.
    vi.mocked(runAudit).mockImplementation(() => {
      throw new Error("python vanished mid-session")
    })
    const h = await freshPlugin({ TOKEN_NORM_AUDIT_EVERY: "2" })
    const s = "ses_audit_throws"

    await toolCall(h, s)
    const out = await toolCall(h, s)

    expect(runAudit).toHaveBeenCalled()
    // The tool's own output is intact; only the reminder was lost.
    expect(out).toContain("tool output")
    expect(out).not.toContain("Audit checkpoint")
  })

  it("survives a toast channel that throws", async () => {
    const showToast = vi.fn(() => {
      throw new Error("tui gone")
    })
    const h = await freshPlugin({ TOKEN_NORM_ANNOUNCE_AT: "1" }, { tui: { showToast } })

    const out = await toolCall(h, "ses_toast_throws")

    expect(showToast).toHaveBeenCalled()
    // The reminder still lands: a decoration failure must not cost the payload.
    expect(out).toContain("TOKEN NORM")
    expect(out).toContain("tool output")
  })

  it("survives a toast channel that rejects asynchronously", async () => {
    const showToast = vi.fn(async () => {
      throw new Error("tui closed")
    })
    const h = await freshPlugin({ TOKEN_NORM_ANNOUNCE_AT: "1" }, { tui: { showToast } })
    expect(await toolCall(h, "ses_toast_rejects")).toContain("TOKEN NORM")
  })

  it("survives a provider lookup that throws while measuring", async () => {
    const h = await freshPlugin(
      { TOKEN_NORM_ANNOUNCE_AT: "1" },
      { config: { providers: vi.fn(() => { throw new Error("providers exploded") }) } },
    )
    const s = "ses_measure_throws"
    await h.event({
      event: {
        type: "message.updated",
        properties: { info: { id: "m1", role: "assistant", sessionID: s, providerID: "p", modelID: "m" } },
      },
    })
    expect(await toolCall(h, s)).toContain("tool output")
  })

  it("reports zeros rather than throwing when status is asked about a malformed session", async () => {
    const h = await freshPlugin()
    expect((await status(h, "")).recommendation).toBe("continue")
  })

  it("swallows malformed and unknown events without throwing", async () => {
    const h = await freshPlugin()
    await expect(h.event({} as never)).resolves.toBeUndefined()
    await expect(h.event({ event: { type: "nonsense.event" } } as never)).resolves.toBeUndefined()
    await expect(h.event({ event: { type: "session.deleted", properties: {} } } as never)).resolves.toBeUndefined()
  })
})

describe("contract: recovery is observable", () => {
  it("drops current back to HEALTHY after compaction while peak holds the high-water mark", async () => {
    const h = await freshPlugin({ TOKEN_NORM_CONTEXT_LIMIT: "1000", TOKEN_NORM_CONTEXT_WARN: "0.5" })
    const s = "ses_recovery"

    await toolCall(h, s)
    await stepFinish(h, s, "p1", 0, { ...ZERO_TOKENS, input: 600 })
    // A tool call after the step is what LATCHES the high-water mark: the
    // status tool reads without latching on purpose (asking where a session
    // stands must not advance its stored level), so the enforcement hook is the
    // only writer. This is the real event order -- a step lands, then the next
    // tool call observes it.
    await toolCall(h, s)

    const pressured = await status(h, s)
    expect(pressured.policy.current).toBe("PRESSURE")
    expect(pressured.policy.peak).toBe("PRESSURE")
    expect(pressured.policy.driver).toBe("context")

    // Compaction is the real recovery event: the window genuinely shrinks.
    await h.event({ event: { type: "session.compacted", properties: { sessionID: s } } })
    await toolCall(h, s)

    const recovered = await status(h, s)
    expect(recovered.session.context).toBe(0)
    expect(recovered.policy.current).toBe("HEALTHY")
    // Monotone: the session already paid for those tokens.
    expect(recovered.policy.peak).toBe("PRESSURE")
    // Advice follows peak, so it does not relax on one cheap call.
    expect(recommendationOf(recovered)).toBe("warn")
    // The deprecated flat alias keeps meaning peak.
    expect(recovered.state).toBe("PRESSURE")
  })

  it("does not let a status read latch the peak it observes", async () => {
    // The read path shares the policy machine but must not share its writes.
    // If status ever latched, merely asking "where am I?" would pin the session
    // at that severity for the rest of its life.
    const h = await freshPlugin({ TOKEN_NORM_CONTEXT_LIMIT: "1000", TOKEN_NORM_CONTEXT_WARN: "0.5" })
    const s = "ses_read_only"

    await toolCall(h, s)
    await stepFinish(h, s, "p1", 0, { ...ZERO_TOKENS, input: 600 })

    // Observed as PRESSURE by the reader, repeatedly...
    expect((await status(h, s)).policy.current).toBe("PRESSURE")
    expect((await status(h, s)).policy.current).toBe("PRESSURE")

    // ...then the window shrinks before any tool call ever saw the pressure.
    await h.event({ event: { type: "session.compacted", properties: { sessionID: s } } })

    const after = await status(h, s)
    expect(after.policy.current).toBe("HEALTHY")
    // Nothing latched it, so there is no stale peak to report.
    expect(after.policy.peak).toBe("HEALTHY")
  })

  it("does not re-inject the budget section when a metric stays over", async () => {
    const h = await freshPlugin({ TOKEN_NORM_MAX_TOOL_CALLS: "2" })
    const s = "ses_no_reinject"
    await toolCall(h, s)
    expect(await toolCall(h, s)).toContain("TOKEN NORM -- BUDGET")
    // Latched: a sustained overage is reported once, not on every call after.
    for (let i = 0; i < 5; i++) expect(await toolCall(h, s)).not.toContain("TOKEN NORM -- BUDGET")
  })
})

function recommendationOf(snapshot: any): string {
  return snapshot.recommendation
}

describe("contract: block mode always leaves an exit", () => {
  it("keeps the handoff tool callable no matter how far over budget the session is", async () => {
    const h = await freshPlugin({ TOKEN_NORM_MODE: "block", TOKEN_NORM_MAX_COST: "0.01" })
    const s = "ses_block_exit"
    await stepFinish(h, s, "p1", 500, ZERO_TOKENS)
    await toolCall(h, s, "todowrite")

    const call = gate(h, s)
    await expect(call("read")).rejects.toThrow(/TOKEN NORM block/)
    // The two ways out, both open at 50,000x the limit.
    await expect(call("handoff")).resolves.toBeUndefined()
    await expect(call("todowrite")).resolves.toBeUndefined()
  })

  it("names the exceeded metric and both remedies in the refusal", async () => {
    const h = await freshPlugin({ TOKEN_NORM_MODE: "block", TOKEN_NORM_MAX_TOOL_CALLS: "1" })
    const s = "ses_block_message"
    await toolCall(h, s)

    // A refusal with no stated way out is a stranded session, so the message
    // itself is part of the contract.
    await expect(gate(h, s)("read")).rejects.toThrow(/handoff/)
    await expect(gate(h, s)("read")).rejects.toThrow(/TOKEN_NORM_MODE=warn/)
  })

  it("blocks nothing in any mode other than block", async () => {
    for (const mode of ["observe", "warn", "handoff"]) {
      const h = await freshPlugin({ TOKEN_NORM_MODE: mode, TOKEN_NORM_MAX_TOOL_CALLS: "1" })
      const s = `ses_no_block_${mode}`
      await toolCall(h, s)
      await toolCall(h, s)
      await expect(gate(h, s)("read")).resolves.toBeUndefined()
    }
  })

  it("does not block a session it has never measured", async () => {
    const h = await freshPlugin({ TOKEN_NORM_MODE: "block", TOKEN_NORM_MAX_TOOL_CALLS: "1" })
    // No tool call has been tracked for this id, so there is no evidence of
    // overspend. Refusing here would block a brand-new session on the previous
    // one's numbers.
    await expect(gate(h, "ses_never_seen")("read")).resolves.toBeUndefined()
  })

  it("does not block on pressure alone when no hard limit is exceeded", async () => {
    // Context pressure is PRESSURE, not BLOCKED: the wall is the limit, and the
    // warn fraction is only a warning. Blocking at 50% of the window would
    // strand a session that is still perfectly able to finish.
    const h = await freshPlugin({
      TOKEN_NORM_MODE: "block",
      TOKEN_NORM_CONTEXT_LIMIT: "1000",
      TOKEN_NORM_CONTEXT_WARN: "0.5",
    })
    const s = "ses_pressure_not_block"
    await toolCall(h, s)
    await stepFinish(h, s, "p1", 0, { ...ZERO_TOKENS, input: 600 })

    expect((await status(h, s)).policy.current).toBe("PRESSURE")
    await expect(gate(h, s)("read")).resolves.toBeUndefined()

    // At the wall itself it does block.
    await stepFinish(h, s, "p2", 0, { ...ZERO_TOKENS, input: 1000 })
    await expect(gate(h, s)("read")).rejects.toThrow(/TOKEN NORM block/)
  })
})
