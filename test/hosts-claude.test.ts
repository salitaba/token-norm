import fs from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const dirs = vi.hoisted(() => {
  // No imported binding may be touched in here: vi.hoisted runs before the
  // module's imports are initialised. The directory itself is created lazily by
  // DiskStore (mkdir recursive on first write).
  const tmp = process.env.TMPDIR || "/tmp"
  const stateRoot = `${tmp}/token-norm-claude-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  process.env.TOKEN_NORM_STATE_DIR = stateRoot
  process.env.TOKEN_NORM_ANNOUNCE_AT = "25"
  process.env.TOKEN_NORM_BOUNDARY_AT = "40"
  process.env.TOKEN_NORM_AUDIT_EVERY = "60"
  process.env.TOKEN_NORM_CHEAP_TOOLS = "todowrite,question,skill"
  // A window size, because nothing on this host can resolve one: the transcript
  // records tokens and no model limit. Without it the context axis is disabled.
  process.env.TOKEN_NORM_CONTEXT_LIMIT = "1000000"
  // Set and expected to be IGNORED: there is no price data in a transcript.
  process.env.TOKEN_NORM_MAX_COST = "5"
  delete process.env.TOKEN_NORM_MODE
  return { stateRoot }
})

vi.mock("../src/core/log.js", () => ({ log: vi.fn(), logConfigDiagnostics: vi.fn(() => []) }))
vi.mock("../src/core/audit.js", () => ({ runAudit: vi.fn(() => "effective fresh tokens: 123k") }))

import type { RawTokens } from "../src/core/host.js"
import { state } from "../src/core/budget/state.js"
import { handleHook } from "../src/hosts/claude/adapter.js"
import { hookResponse, installStore } from "../src/hosts/claude/main.js"
import { measureSession } from "../src/hosts/claude/measure.js"
import type { HookInput, HookOutput } from "../src/hosts/claude/protocol.js"
import type { TranscriptRead, TranscriptTurn } from "../src/usage/claude.js"

const WINDOW: RawTokens = { input: 2_000, output: 1_000, cache: { read: 47_000, write: 0 } }

function turn(tokens: RawTokens, sidechain = false, key = Math.random().toString(36)): TranscriptTurn {
  return { key, sidechain, tokens, measured: true }
}

/** A TranscriptRead as `readTranscript` would return it: cumulative `tokens`
 * over every measured turn, plus the last one on its own. */
function transcript(turns: TranscriptTurn[]): TranscriptRead {
  const total: RawTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  for (const t of turns) {
    total.input! += t.tokens.input ?? 0
    total.output! += t.tokens.output ?? 0
    total.reasoning! += t.tokens.reasoning ?? 0
    total.cache!.read! += t.tokens.cache?.read ?? 0
    total.cache!.write! += t.tokens.cache?.write ?? 0
  }
  return {
    source: turns.length > 0 ? "measured" : "counted",
    path: "/tmp/transcript.jsonl",
    turns,
    measuredTurns: turns.length,
    tokens: total,
    latest: turns.length > 0 ? turns[turns.length - 1].tokens : undefined,
    lines: turns.length,
    skipped: 0,
    partial: false,
  }
}

const READ = transcript([turn(WINDOW)])

/** One hook invocation as the host makes it: a fresh process, so a fresh store
 * that must load everything it knows from disk. */
function hook(event: string, input: Partial<HookInput> = {}, read = READ): HookOutput | undefined {
  installStore()
  return handleHook(
    { hook_event_name: event, session_id: "ses_claude", tool_name: "read", ...input },
    { read: () => read },
  )
}

function post(n: number, input: Partial<HookInput> = {}): HookOutput | undefined {
  let last: HookOutput | undefined
  for (let i = 0; i < n; i++) last = hook("PostToolUse", input)
  return last
}

function context(out: HookOutput | undefined): string {
  return out?.hookSpecificOutput?.additionalContext ?? ""
}

beforeEach(() => {
  installStore()
  state.clear()
})

describe("Claude Code hook adapter", () => {
  it("delivers the reminder to the MODEL, not to the user", () => {
    const out = post(25)
    // THE field check. `systemMessage` renders to the human and the model never
    // sees it, so a reminder delivered there would look like success from the
    // outside while reaching nobody who can act on it.
    expect(out?.hookSpecificOutput?.hookEventName).toBe("PostToolUse")
    expect(context(out)).toContain("TOKEN NORM")
    expect(context(out)).toContain("cost statement")
    expect(out?.systemMessage ?? "").not.toContain("cost statement")
    // The operator line carries severity only.
    expect(out?.systemMessage).toContain("25 calls")
    expect(out?.hookSpecificOutput?.permissionDecision).toBeUndefined()
  })

  it("counts across hook processes, which each start with an empty store", () => {
    post(25)
    installStore()
    expect(state.get("ses_claude")?.calls).toBe(25)
  })

  it("persists its latches, so the announce fires once and not once per call", () => {
    expect(context(post(25))).toContain("TOKEN NORM")
    // Without state.save() at the handler's exit, `announced` dies with the
    // process and every later call re-announces.
    installStore()
    expect(state.get("ses_claude")?.announced).toBe(true)
    expect(context(post(1))).toBe("")
    expect(context(post(1))).toBe("")
  })

  it("does not count cheap tools toward the thresholds", () => {
    post(100, { tool_name: "todowrite" })
    installStore()
    expect(state.get("ses_claude")?.calls).toBe(0)
    expect(context(post(24))).toBe("")
  })

  it("arms the task boundary on UserPromptSubmit and injects on the next call", () => {
    post(40)
    expect(hook("UserPromptSubmit")).toBeUndefined()
    installStore()
    expect(state.get("ses_claude")?.pendingBoundary).toBe(true)
    const out = post(1)
    expect(context(out)).toContain("TASK BOUNDARY")
    // Spent, not re-armed: this is the reminder that once fired 61 times.
    expect(context(post(1))).not.toContain("TASK BOUNDARY")
  })

  it("ignores a prompt submitted before the boundary threshold", () => {
    post(10)
    hook("UserPromptSubmit")
    installStore()
    expect(state.get("ses_claude")?.pendingBoundary).toBe(false)
  })

  it("counts a failed tool call but injects nothing into an error", () => {
    post(24)
    expect(hook("PostToolUseFailure")).toBeUndefined()
    installStore()
    expect(state.get("ses_claude")?.calls).toBe(25)
  })

  it("drops the record on SessionEnd so the state dir does not grow forever", () => {
    post(3)
    const file = fs.readdirSync(path.join(dirs.stateRoot, "claude"))
    expect(file.some((f) => f.endsWith(".json"))).toBe(true)
    hook("SessionEnd")
    installStore()
    expect(state.get("ses_claude")).toBeUndefined()
  })

  it("never blocks, and says nothing at all, outside block mode", () => {
    post(25)
    expect(hook("PreToolUse")).toBeUndefined()
  })

  it("says nothing for input it cannot use", () => {
    expect(hookResponse("not json")).toBe("")
    expect(hookResponse("")).toBe("")
    expect(hookResponse(JSON.stringify({ hook_event_name: "PostToolUse" }))).toBe("")
    expect(hookResponse(JSON.stringify({ hook_event_name: "Notification", session_id: "x" }))).toBe("")
    expect(hookResponse(JSON.stringify([1, 2, 3]))).toBe("")
  })
})

describe("measureSession", () => {
  const blank = {
    calls: 4,
    weightedCalls: 4,
    announced: false,
    lastAudit: 0,
    tools: new Map<string, number>(),
    seenMessages: new Set<string>(),
    pendingBoundary: false,
    pendingHandoff: false,
    crossed: new Set<string>(),
    level: "HEALTHY" as const,
    axisLevels: {},
  }

  it("feeds the context axis window occupancy, not cumulative spend", () => {
    // Ten turns of the same 50k window re-read. Cumulative cache_read is 470k;
    // the window still holds 50k. Summing it would report 520k against a 1M
    // limit -- half full after ten turns, for a session that never grew.
    const read = transcript(Array.from({ length: 10 }, () => turn(WINDOW)))
    const { metrics, rollup } = measureSession("ses_m", read, { ...blank })
    const ctx = metrics.find((m) => m.key === "context")
    expect(ctx?.used).toBe(50_000)
    // And the spend axis gets the cumulative figure, which is the larger one.
    expect(rollup.effectiveTokens).toBeGreaterThan(50_000)
  })

  it("counts subagent turns as spend but not as this session's window", () => {
    const read = transcript([turn(WINDOW), turn({ input: 400_000, cache: { read: 400_000 } }, true)])
    const { metrics, rollup } = measureSession("ses_s", read, { ...blank })
    expect(metrics.find((m) => m.key === "context")?.used).toBe(50_000)
    expect(rollup.effectiveTokens).toBeGreaterThan(400_000)
  })

  it("omits the cost axis rather than reporting an unmeasured zero", () => {
    const { metrics, rollup } = measureSession("ses_c", READ, { ...blank })
    expect(metrics.map((m) => m.key)).not.toContain("cost")
    expect(rollup.costUsd).toBe(0)
  })

  it("reports an unreadable transcript as unmeasured, never as zero spend", () => {
    const read: TranscriptRead = {
      ...transcript([]),
      source: "unreadable",
      reason: "EACCES",
    }
    const { measured, metrics } = measureSession("ses_u", read, { ...blank })
    expect(measured).toBe(false)
    expect(metrics.find((m) => m.key === "context")?.used).toBe(0)
  })
})
