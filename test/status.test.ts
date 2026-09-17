import { describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  process.env.TOKEN_NORM_ANNOUNCE_AT = "25"
  process.env.TOKEN_NORM_BOUNDARY_AT = "40"
  process.env.TOKEN_NORM_AUDIT_EVERY = "60"
  process.env.TOKEN_NORM_CHEAP_TOOLS = "todowrite,question,skill"
})

vi.mock("../src/core/log.js", () => ({ log: vi.fn(), logConfigDiagnostics: vi.fn(() => []) }))
vi.mock("../src/core/audit.js", () => ({ runAudit: vi.fn(() => "effective fresh tokens: 123k") }))

import {
  createStatusTool,
  emptyStatus,
  readStatus,
  recommendationFor,
  renderStatus,
  snapshotFrom,
  type StatusSnapshot,
} from "../src/status.js"

describe("status snapshot", () => {
  it("maps facts to the wire shape, using null for unconfigured limits", () => {
    expect(
      snapshotFrom({
        toolCalls: 7,
        context: 1234,
        cost: { used: 0.5 },
        effectiveTokens: { used: 100 },
        current: "HEALTHY",
      }),
    ).toEqual({
      session: { scope: "current-session", context: 1234, contextLimit: null },
      budget: {
        scope: "session-tree",
        toolCalls: 7,
        cost: { used: 0.5, limit: null },
        effectiveTokens: { used: 100, limit: null },
      },
      // `state` stays on the wire as the deprecated alias of policy.peak.
      state: "HEALTHY",
      policy: { current: "HEALTHY", peak: "HEALTHY", driver: "calls" },
      recommendation: "continue",
    })
  })

  it("carries configured limits and the context window", () => {
    const snap = snapshotFrom({
      toolCalls: 1,
      context: 50,
      contextLimit: 100,
      cost: { used: 1, limit: 2 },
      effectiveTokens: { used: 3, limit: 1000 },
      current: "HEALTHY",
    })
    expect(snap.session).toEqual({ scope: "current-session", context: 50, contextLimit: 100 })
    expect(snap.budget).toEqual({
      scope: "session-tree",
      toolCalls: 1,
      cost: { used: 1, limit: 2 },
      effectiveTokens: { used: 3, limit: 1000 },
    })
  })

  // The mode no longer enters here. It is applied once, inside the policy
  // machine, when the state is computed; by the time a snapshot is built the
  // severity is already decided and this is a pure naming of it.
  it("names every policy state with one recommendation", () => {
    expect(recommendationFor("HEALTHY")).toBe("continue")
    expect(recommendationFor("ATTENTION")).toBe("warn")
    expect(recommendationFor("PRESSURE")).toBe("warn")
    expect(recommendationFor("HANDOFF_RECOMMENDED")).toBe("handoff")
    expect(recommendationFor("BLOCKED")).toBe("block")
  })

  // The distinction the flat `state` field could not express: "this is bad
  // right now" versus "this has been bad at some point".
  it("reports current and peak separately, and keeps state as the peak alias", () => {
    const snap = snapshotFrom({
      toolCalls: 9,
      context: 0,
      cost: { used: 0 },
      effectiveTokens: { used: 0 },
      current: "ATTENTION",
      peak: "PRESSURE",
      driver: "calls",
    })
    expect(snap.policy).toEqual({ current: "ATTENTION", peak: "PRESSURE", driver: "calls" })
    expect(snap.state).toBe("PRESSURE")
    // Advice follows the peak: the money is already spent.
    expect(snap.recommendation).toBe("warn")
  })

  it("never lets peak fall below current, even if a caller passes a stale peak", () => {
    const snap = snapshotFrom({
      toolCalls: 0,
      context: 0,
      cost: { used: 0 },
      effectiveTokens: { used: 0 },
      current: "BLOCKED",
      peak: "HEALTHY",
    })
    expect(snap.policy.peak).toBe("BLOCKED")
    expect(snap.state).toBe("BLOCKED")
    expect(snap.recommendation).toBe("block")
  })

  it("defaults peak to current and driver to the calls axis", () => {
    const snap = snapshotFrom({
      toolCalls: 0,
      context: 0,
      cost: { used: 0 },
      effectiveTokens: { used: 0 },
      current: "PRESSURE",
    })
    expect(snap.policy).toEqual({ current: "PRESSURE", peak: "PRESSURE", driver: "calls" })
  })

  it("renders parseable JSON", () => {
    expect(JSON.parse(renderStatus(emptyStatus()))).toEqual(emptyStatus())
  })

  it("returns zeros with no provider, and zeros when a provider throws", async () => {
    expect(await readStatus(undefined, "ses_none")).toEqual(emptyStatus())
    expect(await readStatus(undefined, undefined)).toEqual(emptyStatus())

    expect(
      await readStatus(() => {
        throw new Error("boom")
      }, "ses_throw"),
    ).toEqual(emptyStatus())

    expect(await readStatus(async () => undefined, "ses_undefined")).toEqual(emptyStatus())

    const ok: StatusSnapshot = snapshotFrom({
      toolCalls: 2,
      context: 10,
      cost: { used: 0 },
      effectiveTokens: { used: 0 },
      current: "HEALTHY",
    })
    expect(await readStatus(() => ok, "ses_ok")).toEqual(ok)
  })

  it("binds each tool to its injected provider, with no module global", async () => {
    const snapshotFor = (toolCalls: number): StatusSnapshot =>
      snapshotFrom({
        toolCalls,
        context: 0,
        cost: { used: 0 },
        effectiveTokens: { used: 0 },
        current: "HEALTHY",
      })
    const first: any = createStatusTool(() => snapshotFor(1))
    const second: any = createStatusTool(() => snapshotFor(2))
    const run = async (t: any) =>
      JSON.parse((await t.execute({}, { sessionID: "ses_x" })).output) as StatusSnapshot
    expect((await run(first)).budget.toolCalls).toBe(1)
    expect((await run(second)).budget.toolCalls).toBe(2)
  })
})

const TIER1_KEYS = [
  "TOKEN_NORM_MODE",
  "TOKEN_NORM_MAX_COST",
  "TOKEN_NORM_MAX_EFFECTIVE_TOKENS",
  "TOKEN_NORM_MAX_TOOL_CALLS",
  "TOKEN_NORM_CONTEXT_WARN",
  "TOKEN_NORM_CONTEXT_LIMIT",
]

async function freshPlugin(env: Record<string, string> = {}): Promise<any> {
  vi.resetModules()
  for (const key of TIER1_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  const mod = await import("../src/session-budget.js")
  return mod.SessionBudgetPlugin({ client: undefined } as never)
}

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

async function toolCall(h: any, sessionID: string, tool = "read", args: any = {}): Promise<void> {
  const output = { title: "t", output: "x".repeat(100), metadata: {} }
  await h["tool.execute.after"]({ tool, sessionID, callID: "call_1", args }, output)
}

async function stepFinish(h: any, sessionID: string, id: string, cost: number, tokens: any): Promise<void> {
  await h.event({
    event: {
      type: "message.part.updated",
      properties: { part: { type: "step-finish", id, sessionID, cost, tokens } },
    },
  })
}

async function status(h: any, sessionID: string): Promise<StatusSnapshot> {
  const result = await h.tool.token_norm_status.execute({}, { sessionID } as never)
  return JSON.parse(result.output)
}

describe("token_norm_status tool", () => {
  it("reports zeros for an unknown session", async () => {
    const h = await freshPlugin()
    expect(await status(h, "ses_unknown")).toEqual({
      session: { scope: "current-session", context: 0, contextLimit: null },
      budget: {
        scope: "session-tree",
        toolCalls: 0,
        cost: { used: 0, limit: null },
        effectiveTokens: { used: 0, limit: null },
      },
      state: "HEALTHY",
      policy: { current: "HEALTHY", peak: "HEALTHY", driver: "calls" },
      recommendation: "continue",
    })
  })

  it("reports calls, cost, tokens, limits, and context from the enforcement accumulators", async () => {
    const h = await freshPlugin({
      TOKEN_NORM_MODE: "warn",
      TOKEN_NORM_MAX_COST: "2",
      TOKEN_NORM_MAX_EFFECTIVE_TOKENS: "1000",
      TOKEN_NORM_MAX_TOOL_CALLS: "10",
      TOKEN_NORM_CONTEXT_LIMIT: "500",
    })
    const s = "ses_status"
    await toolCall(h, s)
    await toolCall(h, s)
    await stepFinish(h, s, "p1", 0.5, { input: 100, output: 0, reasoning: 0, cache: { read: 200, write: 0 } })

    const snap = await status(h, s)
    expect(snap.session).toEqual({ scope: "current-session", context: 300, contextLimit: 500 })
    expect(snap.budget.toolCalls).toBe(2)
    expect(snap.budget.cost).toEqual({ used: 0.5, limit: 2 })
    expect(snap.budget.effectiveTokens).toEqual({ used: 120, limit: 1000 })
    expect(snap.recommendation).toBe("continue")
  })

  it("counts budgeted calls across child sessions, matching the budget rollup", async () => {
    const h = await freshPlugin({ TOKEN_NORM_MAX_TOOL_CALLS: "10" })
    const parent = "ses_parent"
    const child = "ses_child"
    await h.event({ event: { type: "session.updated", properties: { info: { id: child, parentID: parent } } } })
    await toolCall(h, parent)
    await toolCall(h, child)

    const snap = await status(h, parent)
    expect(snap.budget.scope).toBe("session-tree")
    expect(snap.budget.toolCalls).toBe(2)
  })

  it("recommends warn at a crossed metric and block only in block mode", async () => {
    const warn = await freshPlugin({ TOKEN_NORM_MODE: "warn", TOKEN_NORM_MAX_TOOL_CALLS: "3" })
    await toolCall(warn, "ses_warn")
    await toolCall(warn, "ses_warn")
    expect((await status(warn, "ses_warn")).recommendation).toBe("continue")
    await toolCall(warn, "ses_warn")
    const crossed = await status(warn, "ses_warn")
    expect(crossed.budget.toolCalls).toBe(3)
    expect(crossed.recommendation).toBe("warn")

    const block = await freshPlugin({ TOKEN_NORM_MODE: "block", TOKEN_NORM_MAX_TOOL_CALLS: "1" })
    await toolCall(block, "ses_block")
    expect((await status(block, "ses_block")).recommendation).toBe("block")
  })

  // Pressure alone is NOT a handoff, even in handoff mode. The plugin has
  // always required a pause as well -- recommending a split mid-task would
  // interrupt work in flight -- but the status tool used to derive its own
  // answer from (pressured, mode) and so reported "handoff" for a session the
  // plugin would only have warned about. Both now read the same machine.
  it("reports handoff only once a pause joins the pressure", async () => {
    const h = await freshPlugin({
      TOKEN_NORM_MODE: "handoff",
      TOKEN_NORM_CONTEXT_LIMIT: "1000",
      TOKEN_NORM_CONTEXT_WARN: "0.5",
    })
    const s = "ses_handoff_status"
    await toolCall(h, s)
    await stepFinish(h, s, "p1", 0, { ...ZERO_TOKENS, input: 600 })

    const pressured = await status(h, s)
    expect(pressured.session.context).toBe(600)
    expect(pressured.session.contextLimit).toBe(1000)
    expect(pressured.state).toBe("PRESSURE")
    expect(pressured.recommendation).toBe("warn")

    await h.event({ event: { type: "session.idle", properties: { sessionID: s } } })
    const paused = await status(h, s)
    expect(paused.state).toBe("HANDOFF_RECOMMENDED")
    expect(paused.recommendation).toBe("handoff")

    const warn = await freshPlugin({
      TOKEN_NORM_MODE: "warn",
      TOKEN_NORM_CONTEXT_LIMIT: "1000",
      TOKEN_NORM_CONTEXT_WARN: "0.5",
    })
    await toolCall(warn, "ses_pressure_warn")
    await stepFinish(warn, "ses_pressure_warn", "p1", 0, { ...ZERO_TOKENS, input: 600 })
    expect((await status(warn, "ses_pressure_warn")).recommendation).toBe("warn")
  })

  it("never throws when the context window cannot be resolved", async () => {
    vi.resetModules()
    for (const key of TIER1_KEYS) delete process.env[key]
    const mod = await import("../src/session-budget.js")
    const h: any = await mod.SessionBudgetPlugin({
      client: { config: { providers: vi.fn().mockRejectedValue(new Error("providers down")) } },
    } as never)
    const s = "ses_no_window"
    await h.event({
      event: {
        type: "message.updated",
        properties: { info: { id: "m1", role: "assistant", sessionID: s, providerID: "p", modelID: "m" } },
      },
    })
    await toolCall(h, s)

    const snap = await status(h, s)
    expect(snap.session.contextLimit).toBeNull()
    expect(snap.recommendation).toBe("continue")
  })
})
