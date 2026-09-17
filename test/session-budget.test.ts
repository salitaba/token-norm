import { describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  process.env.TOKEN_NORM_ANNOUNCE_AT = "25"
  process.env.TOKEN_NORM_BOUNDARY_AT = "40"
  process.env.TOKEN_NORM_AUDIT_EVERY = "60"
  process.env.TOKEN_NORM_CHEAP_TOOLS = "todowrite,question,skill"
})

vi.mock("../src/core/log.js", () => ({ log: vi.fn(), logConfigDiagnostics: vi.fn(() => []) }))
vi.mock("../src/core/audit.js", () => ({ runAudit: vi.fn(() => "effective fresh tokens: 123k") }))

import { runAudit } from "../src/core/audit.js"
import { log } from "../src/core/log.js"
import { SessionBudgetPlugin } from "../src/session-budget.js"

const hooks = await SessionBudgetPlugin({} as never)

function blank() {
  return { title: "t", output: "tool output", metadata: {} }
}

async function callTool(sessionID: string, tool = "read"): Promise<string> {
  const output = blank()
  await hooks["tool.execute.after"]!({ tool, sessionID, callID: "call_1", args: {} }, output)
  return output.output
}

async function calls(sessionID: string, n: number, tool = "read"): Promise<string> {
  let last = ""
  for (let i = 0; i < n; i++) last = await callTool(sessionID, tool)
  return last
}

async function userMessage(sessionID: string, id: string | undefined, role = "user") {
  await hooks.event!({
    event: { type: "message.updated", properties: { info: { id, role, sessionID } } },
  } as never)
}

describe("SessionBudgetPlugin", () => {
  it("counts calls, but not cheap tools", async () => {
    await calls("ses_cheap", 100, "todowrite")
    const under = await calls("ses_cheap", 24)
    expect(under).not.toContain("TOKEN NORM")

    const at25 = await callTool("ses_cheap")
    expect(at25).toContain("25 tool calls")
    expect(at25).toContain("session split")
  })

  it("demands the cost statement once per session", async () => {
    await calls("ses_announce", 25)
    const after = await calls("ses_announce", 34)
    expect(after).not.toContain("TOKEN NORM")
  })

  it("runs the audit every 60 calls", async () => {
    await calls("ses_audit", 59)
    expect(runAudit).not.toHaveBeenCalled()

    const at60 = await callTool("ses_audit")
    expect(at60).toContain("Audit checkpoint")
    expect(at60).toContain("effective fresh tokens: 123k")
    expect(runAudit).toHaveBeenCalledWith("ses_audit")

    await calls("ses_audit", 59)
    expect(runAudit).toHaveBeenCalledTimes(1)

    const at120 = await callTool("ses_audit")
    expect(at120).toContain("Audit checkpoint")
    expect(runAudit).toHaveBeenCalledTimes(2)
  })

  it("fires the task-boundary reminder once per user message, not per tool call", async () => {
    const s = "ses_boundary"
    await calls(s, 40)
    await userMessage(s, undefined)
    for (let i = 0; i < 10; i++) await userMessage(s, "msg_1")

    const first = await callTool(s)
    expect(first.match(/TASK BOUNDARY/g)).toHaveLength(1)

    const second = await callTool(s)
    expect(second).not.toContain("TASK BOUNDARY")

    await userMessage(s, "msg_2")
    const third = await callTool(s)
    expect(third).toContain("TASK BOUNDARY")
  })

  it("ignores boundaries in a cold session, and assistant messages", async () => {
    const cold = "ses_cold"
    await calls(cold, 5)
    await userMessage(cold, "msg_cold")
    expect(await callTool(cold)).not.toContain("TASK BOUNDARY")

    const assistant = "ses_assistant"
    await calls(assistant, 40)
    await userMessage(assistant, "msg_assistant", "assistant")
    expect(await callTool(assistant)).not.toContain("TASK BOUNDARY")
  })

  it("adds the live call count at compaction, and nothing for unknown sessions", async () => {
    const known = "ses_compact"
    await calls(known, 3)
    const output = { context: [] as string[] }
    await hooks["experimental.session.compacting"]!({ sessionID: known }, output)
    expect(output.context).toHaveLength(1)
    expect(output.context[0]).toContain("3 tool calls")

    const unknown = { context: [] as string[] }
    await hooks["experimental.session.compacting"]!({ sessionID: "ses_never_seen" }, unknown)
    expect(unknown.context).toHaveLength(0)
  })

  it("arms the boundary on the first call at or past the threshold", async () => {
    const below = "ses_edge_below"
    await calls(below, 39)
    await userMessage(below, "msg_below")
    expect(await callTool(below)).not.toContain("TASK BOUNDARY")

    const at = "ses_edge_at"
    await calls(at, 39)
    await userMessage(at, "msg_arm")
    await calls(at, 1)
    await userMessage(at, "msg_fire")
    expect(await callTool(at)).toContain("TASK BOUNDARY")
  })

  it("starts from zero in a fresh process (no rehydration after restart)", async () => {
    await calls("ses_restart", 25)

    vi.resetModules()
    const fresh = await import("../src/session-budget.js")
    const freshHooks = await fresh.SessionBudgetPlugin({} as never)

    let last = ""
    for (let i = 0; i < 25; i++) {
      const output = blank()
      await freshHooks["tool.execute.after"]!(
        { tool: "read", sessionID: "ses_restart", callID: "call_1", args: {} },
        output,
      )
      last = output.output
    }
    expect(last).toContain("25 tool calls")
  })

  it("evicts activity state when a session is deleted (usage ledger is separate)", async () => {
    const s = "ses_deleted"
    await calls(s, 25)
    await hooks.event!({
      event: { type: "session.deleted", properties: { info: { id: s } } },
    } as never)

    const again = await calls(s, 25)
    expect(again).toContain("25 tool calls")
  })

  it("swallows malformed events", async () => {
    await expect(hooks.event!({} as never)).resolves.toBeUndefined()
  })
})

const TIER1_KEYS = [
  "TOKEN_NORM_MODE",
  "TOKEN_NORM_MAX_COST",
  "TOKEN_NORM_MAX_EFFECTIVE_TOKENS",
  "TOKEN_NORM_MAX_TOOL_CALLS",
  "TOKEN_NORM_CONTEXT_WARN",
  "TOKEN_NORM_CONTEXT_LIMIT",
  "TOKEN_NORM_TOOL_WEIGHTS",
  "TOKEN_NORM_PHASE_WEIGHTS",
]

async function freshPlugin(env: Record<string, string> = {}): Promise<any> {
  vi.resetModules()
  for (const key of TIER1_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  const mod = await import("../src/session-budget.js")
  return mod.SessionBudgetPlugin({ client: undefined } as never)
}

async function toolCall(h: any, sessionID: string, tool = "read", args: any = {}): Promise<string> {
  const output = { title: "t", output: "x".repeat(100), metadata: {} }
  await h["tool.execute.after"]({ tool, sessionID, callID: "call_1", args }, output)
  return output.output
}

async function stepFinish(h: any, sessionID: string, id: string, cost: number, tokens: any): Promise<void> {
  await h.event({
    event: { type: "message.part.updated", properties: { part: { type: "step-finish", id, sessionID, cost, tokens } } },
  })
}

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

describe("SessionBudgetPlugin tier 1 budgets", () => {
  it("parses mode and fractional limits from env, rejecting invalid values", async () => {
    vi.resetModules()
    process.env.TOKEN_NORM_MODE = "nonsense"
    process.env.TOKEN_NORM_CONTEXT_WARN = "0.5"
    process.env.TOKEN_NORM_MAX_COST = "0.50"
    process.env.TOKEN_NORM_MAX_TOOL_CALLS = "0"
    const cfg = await import("../src/core/config.js")
    expect(cfg.MODE).toBe("warn")
    expect(cfg.CONTEXT_WARN).toBe(0.5)
    expect(cfg.MAX_COST).toBe(0.5)
    expect(cfg.MAX_TOOL_CALLS).toBeUndefined()
    for (const key of TIER1_KEYS) delete process.env[key]
  })

  it("injects the budget status once per metric crossing", async () => {
    const h = await freshPlugin({ TOKEN_NORM_MODE: "warn", TOKEN_NORM_MAX_TOOL_CALLS: "3" })
    const s = "ses_budget"
    expect(await toolCall(h, s)).not.toContain("BUDGET")
    expect(await toolCall(h, s)).not.toContain("BUDGET")

    const third = await toolCall(h, s)
    expect(third).toContain("TOKEN NORM -- BUDGET")
    expect(third).toContain("Weighted tool calls: 3 / 3 (100%) -- OVER")
    expect(third).toContain("Crossed now: tool-calls")

    expect(await toolCall(h, s)).not.toContain("BUDGET")
  })

  it("weights budgeted calls by tool and assistant mode, leaving raw counts alone", async () => {
    const h = await freshPlugin({
      TOKEN_NORM_MODE: "warn",
      TOKEN_NORM_MAX_TOOL_CALLS: "5",
      TOKEN_NORM_TOOL_WEIGHTS: "bash=2,read=0.5",
      TOKEN_NORM_PHASE_WEIGHTS: "build=2",
    })
    const s = "ses_weighted"
    await h.event({
      event: {
        type: "message.updated",
        properties: { info: { id: "m1", role: "assistant", sessionID: s, mode: "build" } },
      },
    })

    const first = await toolCall(h, s, "bash")
    expect(first).not.toContain("BUDGET")

    const second = await toolCall(h, s, "read")
    expect(second).toContain("Weighted tool calls: 5 / 5 (100%) -- OVER")
    expect(second).toContain("Crossed now: tool-calls")
  })

  it("observe mode logs the crossing but injects nothing", async () => {
    const h = await freshPlugin({ TOKEN_NORM_MODE: "observe", TOKEN_NORM_MAX_COST: "0.5" })
    const s = "ses_observe"
    await stepFinish(h, s, "p1", 0.6, ZERO_TOKENS)
    vi.mocked(log).mockClear()

    const out = await toolCall(h, s)
    expect(out).not.toContain("BUDGET")
    expect(log).toHaveBeenCalledWith(expect.stringContaining("budget crossing"))
  })

  it("warns on context pressure from an explicit limit", async () => {
    const h = await freshPlugin({ TOKEN_NORM_CONTEXT_LIMIT: "1000", TOKEN_NORM_CONTEXT_WARN: "0.5" })
    const s = "ses_context"
    await stepFinish(h, s, "p1", 0, { ...ZERO_TOKENS, input: 600 })

    const out = await toolCall(h, s)
    expect(out).toContain("Context now: 600 / 1.0k (60%) -- OVER")
  })

  it("caches the resolved model window for the process lifetime", async () => {
    vi.resetModules()
    for (const key of TIER1_KEYS) delete process.env[key]
    process.env.TOKEN_NORM_CONTEXT_WARN = "0.5"
    const providers = vi
      .fn()
      .mockResolvedValue({ data: { providers: [{ id: "p", models: { m: { limit: { context: 1000 } } } }] } })
    const mod = await import("../src/session-budget.js")
    const h: any = await mod.SessionBudgetPlugin({ client: { config: { providers } } } as never)

    const seed = async (s: string) => {
      await h.event({
        event: {
          type: "message.updated",
          properties: { info: { id: `m_${s}`, role: "assistant", sessionID: s, providerID: "p", modelID: "m" } },
        },
      })
      await stepFinish(h, s, `p_${s}`, 0, { ...ZERO_TOKENS, input: 600 })
    }

    await seed("ses_cache_a")
    expect(await toolCall(h, "ses_cache_a")).toContain("Context now: 600 / 1.0k (60%)")

    // Documented semantics: a mid-process provider change is not picked up --
    // the window stays pinned until restart (or an explicit CONTEXT_LIMIT).
    providers.mockResolvedValue({ data: { providers: [{ id: "p", models: { m: { limit: { context: 5000 } } } }] } })
    await seed("ses_cache_b")
    expect(await toolCall(h, "ses_cache_b")).toContain("Context now: 600 / 1.0k (60%)")
    expect(providers).toHaveBeenCalledTimes(1)
  })

  it("block mode refuses non-cheap tools but keeps cheap tools and handoff open", async () => {
    const h = await freshPlugin({ TOKEN_NORM_MODE: "block", TOKEN_NORM_MAX_TOOL_CALLS: "1" })
    const s = "ses_block"
    await toolCall(h, s)

    const call = (tool: string) =>
      h["tool.execute.before"]({ tool, sessionID: s, callID: "c" }, { args: {} })
    await expect(call("read")).rejects.toThrow(/TOKEN NORM block/)
    await expect(call("todowrite")).resolves.toBeUndefined()
    await expect(call("handoff")).resolves.toBeUndefined()
  })

  it("never blocks on an unknown measurement (unresolvable context limit)", async () => {
    vi.resetModules()
    for (const key of TIER1_KEYS) delete process.env[key]
    process.env.TOKEN_NORM_MODE = "block"
    process.env.TOKEN_NORM_MAX_TOOL_CALLS = "100"
    const mod = await import("../src/session-budget.js")
    const h: any = await mod.SessionBudgetPlugin({
      client: { config: { providers: vi.fn().mockRejectedValue(new Error("providers unavailable")) } },
    } as never)
    const s = "ses_unknown_limit"

    await h.event({
      event: {
        type: "message.updated",
        properties: { info: { id: "m1", role: "assistant", sessionID: s, providerID: "p", modelID: "m" } },
      },
    })
    // Provider/model known but the window lookup fails, while the observed
    // context is far beyond any real window. No limit means no context metric,
    // so the call must pass instead of being refused on a guessed limit.
    await stepFinish(h, s, "p1", 0, { input: 9_000_000, output: 0, cache: { read: 0, write: 0 } })

    const call = (tool: string) =>
      h["tool.execute.before"]({ tool, sessionID: s, callID: "c" }, { args: {} })
    await expect(call("read")).resolves.toBeUndefined()
    expect(await toolCall(h, s)).not.toContain("TOKEN NORM block")
  })

  it("handoff mode recommends at idle and pre-fills touched files", async () => {
    const h = await freshPlugin({ TOKEN_NORM_MODE: "handoff", TOKEN_NORM_MAX_TOOL_CALLS: "1" })
    const s = "ses_handoff"
    await toolCall(h, s, "edit", { filePath: "/tmp/x.ts" })
    await h.event({ event: { type: "session.idle", properties: { sessionID: s } } })

    const out = await toolCall(h, s, "todowrite")
    expect(out).toContain("HANDOFF RECOMMENDED")
    expect(out).toContain("Files touched: /tmp/x.ts")
    expect(out).toContain("Skeleton:")

    expect(await toolCall(h, s, "todowrite")).not.toContain("HANDOFF RECOMMENDED")
  })

  it("handoff mode waits for every todo to complete", async () => {
    const h = await freshPlugin({ TOKEN_NORM_MODE: "handoff", TOKEN_NORM_MAX_TOOL_CALLS: "1" })
    const s = "ses_todos"
    await toolCall(h, s)

    await h.event({
      event: { type: "todo.updated", properties: { sessionID: s, todos: [{ status: "in_progress" }] } },
    })
    expect(await toolCall(h, s, "todowrite")).not.toContain("HANDOFF RECOMMENDED")

    await h.event({
      event: { type: "todo.updated", properties: { sessionID: s, todos: [{ status: "completed" }] } },
    })
    expect(await toolCall(h, s, "todowrite")).toContain("HANDOFF RECOMMENDED")
  })
})
