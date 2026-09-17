import { describe, expect, it, vi, type Mock } from "vitest"

vi.mock("../src/core/log.js", () => ({ log: vi.fn(), logConfigDiagnostics: vi.fn(() => []) }))
vi.mock("../src/core/audit.js", () => ({ runAudit: vi.fn(() => "effective fresh tokens: 123k") }))

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

type Step =
  | { kind: "user"; id: string; role?: string }
  | { kind: "step-finish"; id: string; cost: number; tokens?: Record<string, unknown> }
  | { kind: "tool"; tool?: string; args?: Record<string, unknown> }
  | { kind: "idle" }
  | { kind: "todos"; todos: Array<{ status: string }> }

const MANAGED_ENV = [
  "TOKEN_NORM_MODE",
  "TOKEN_NORM_MAX_COST",
  "TOKEN_NORM_MAX_EFFECTIVE_TOKENS",
  "TOKEN_NORM_MAX_TOOL_CALLS",
  "TOKEN_NORM_CONTEXT_WARN",
  "TOKEN_NORM_CONTEXT_LIMIT",
  "TOKEN_NORM_ANNOUNCE_AT",
  "TOKEN_NORM_AUDIT_EVERY",
  "TOKEN_NORM_BOUNDARY_AT",
  "TOKEN_NORM_CHEAP_TOOLS",
]

async function load(env: Record<string, string> = {}): Promise<{ hooks: any; runAudit: Mock }> {
  vi.resetModules()
  for (const key of MANAGED_ENV) delete process.env[key]
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  const audit = await import("../src/core/audit.js")
  const mod = await import("../src/session-budget.js")
  const hooks = await mod.SessionBudgetPlugin({ client: undefined } as never)
  return { hooks, runAudit: audit.runAudit as unknown as Mock }
}

function eventFor(step: Exclude<Step, { kind: "tool" }>, sessionID: string): unknown {
  switch (step.kind) {
    case "user":
      return { type: "message.updated", properties: { info: { id: step.id, role: step.role ?? "user", sessionID } } }
    case "step-finish":
      return {
        type: "message.part.updated",
        properties: { part: { type: "step-finish", id: step.id, sessionID, cost: step.cost, tokens: step.tokens ?? ZERO_TOKENS } },
      }
    case "idle":
      return { type: "session.idle", properties: { sessionID } }
    case "todos":
      return { type: "todo.updated", properties: { sessionID, todos: step.todos } }
  }
}

async function replay(hooks: any, sessionID: string, steps: Step[]): Promise<string[]> {
  const outputs: string[] = []
  for (const step of steps) {
    if (step.kind === "tool") {
      const output = { title: "t", output: "tool output", metadata: {} }
      await hooks["tool.execute.after"](
        { tool: step.tool ?? "read", sessionID, callID: "call_1", args: step.args ?? {} },
        output,
      )
      outputs.push(output.output)
      continue
    }
    await hooks.event({ event: eventFor(step, sessionID) })
  }
  return outputs
}

const tools = (n: number): Step[] => Array.from({ length: n }, () => ({ kind: "tool" as const }))

async function status(hooks: any, sessionID: string): Promise<any> {
  const result = await hooks.tool.token_norm_status.execute({}, { sessionID })
  return JSON.parse(result.output)
}

describe("event ordering", () => {
  // Reminders due on the same call COEXIST in one block; they no longer
  // suppress each other.
  //
  // The old hook returned early after the boundary and again after the
  // announce, so three thresholds landing together were spread across three
  // tool calls and the budget check was skipped on two of them. Deferral was
  // never the goal -- it was a side effect of the early returns, and it
  // delayed exactly the warnings that were most overdue. One block, one
  // header, fixed section order.
  it("collects every reminder due on the same call into one block", async () => {
    const { hooks, runAudit } = await load({
      TOKEN_NORM_ANNOUNCE_AT: "41",
      TOKEN_NORM_AUDIT_EVERY: "41",
      TOKEN_NORM_BOUNDARY_AT: "40",
    })
    const s = "ses_priority"
    const before = await replay(hooks, s, [...tools(40), { kind: "user", id: "m1" }])
    expect(before[39]).not.toContain("TOKEN NORM")
    expect(runAudit).not.toHaveBeenCalled()

    const together = await replay(hooks, s, [{ kind: "tool" }])
    expect(together[0]).toContain("new request arrived 41 tool calls deep")
    expect(together[0]).toContain("41 tool calls in this session")
    expect(together[0]).toContain("Audit checkpoint")
    expect(together[0]).toContain("effective fresh tokens: 123k")
    expect(runAudit).toHaveBeenCalledTimes(1)
    expect(runAudit).toHaveBeenCalledWith(s)

    // One block, not three: a single <system-reminder> wrapper carrying a
    // single state header.
    expect(together[0].match(/<system-reminder>/g)).toHaveLength(1)
    expect(together[0].match(/^TOKEN NORM -- (HEALTHY|ATTENTION|PRESSURE|HANDOFF_RECOMMENDED|BLOCKED)/gm)).toHaveLength(1)

    // Each latch still holds afterwards: announce is once-ever, the audit
    // waits a full interval, the boundary needs a new user message.
    const quiet = await replay(hooks, s, [{ kind: "tool" }])
    expect(quiet[0]).not.toContain("TOKEN NORM")
    expect(runAudit).toHaveBeenCalledTimes(1)
  })

  it("injects the boundary once at the next tool call, across revisions and step events", async () => {
    const { hooks } = await load({
      TOKEN_NORM_ANNOUNCE_AT: "9999",
      TOKEN_NORM_AUDIT_EVERY: "9999",
      TOKEN_NORM_BOUNDARY_AT: "40",
    })
    const s = "ses_interleaved"
    const outputs = await replay(hooks, s, [
      ...tools(40),
      { kind: "user", id: "m1" },
      { kind: "user", id: "m1" },
      { kind: "step-finish", id: "p1", cost: 0.1, tokens: { input: 10 } },
      { kind: "user", id: "m1" },
      { kind: "tool" },
      { kind: "tool" },
      { kind: "user", id: "m2" },
      { kind: "tool" },
    ])

    expect(outputs[39]).not.toContain("TASK BOUNDARY")
    expect(outputs[40]).toContain("new request arrived 41 tool calls deep")
    expect(outputs[41]).not.toContain("TASK BOUNDARY")
    expect(outputs[42]).toContain("new request arrived 43 tool calls deep")
  })

  it("keeps counters and step usage aligned when events interleave", async () => {
    const { hooks } = await load({
      TOKEN_NORM_ANNOUNCE_AT: "9999",
      TOKEN_NORM_AUDIT_EVERY: "9999",
      TOKEN_NORM_BOUNDARY_AT: "9999",
      TOKEN_NORM_MAX_TOOL_CALLS: "2",
      TOKEN_NORM_MAX_COST: "1",
    })
    const s = "ses_counters"
    const outputs = await replay(hooks, s, [
      { kind: "tool", tool: "todowrite" },
      { kind: "tool" },
      { kind: "step-finish", id: "p1", cost: 0.25, tokens: { input: 100, output: 50, cache: { read: 200, write: 10 } } },
      { kind: "tool", tool: "question" },
      { kind: "tool" },
      { kind: "step-finish", id: "p1", cost: 0.25, tokens: { input: 100, output: 50, cache: { read: 200, write: 10 } } },
    ])

    expect(outputs[0]).not.toContain("TOKEN NORM")
    expect(outputs[1]).not.toContain("BUDGET")
    expect(outputs[3]).toContain("Weighted tool calls: 2 / 2 (100%) -- OVER")

    const snap = await status(hooks, s)
    expect(snap.budget.toolCalls).toBe(2)
    expect(snap.budget.cost).toEqual({ used: 0.25, limit: 1 })
    expect(snap.budget.effectiveTokens.used).toBeCloseTo(132.5, 5)
    expect(snap.session.context).toBe(360)
    expect(snap.recommendation).toBe("warn")
  })

  it("arms a handoff only when the pause follows budget pressure", async () => {
    const { hooks } = await load({
      TOKEN_NORM_MODE: "handoff",
      TOKEN_NORM_MAX_TOOL_CALLS: "2",
      TOKEN_NORM_ANNOUNCE_AT: "9999",
      TOKEN_NORM_AUDIT_EVERY: "9999",
      TOKEN_NORM_BOUNDARY_AT: "9999",
    })
    const s = "ses_handoff_order"
    const outputs = await replay(hooks, s, [
      { kind: "idle" },
      { kind: "tool" },
      { kind: "tool" },
      { kind: "tool", tool: "todowrite" },
      { kind: "todos", todos: [{ status: "completed" }] },
      { kind: "tool", tool: "todowrite" },
      { kind: "tool", tool: "todowrite" },
    ])

    expect(outputs[0]).not.toContain("HANDOFF RECOMMENDED")
    expect(outputs[2]).not.toContain("HANDOFF RECOMMENDED")
    expect(outputs[3]).toContain("HANDOFF RECOMMENDED")
    expect(outputs[4]).not.toContain("HANDOFF RECOMMENDED")
  })
})
