// Block mode lives in its own file because MODE is read from the environment
// once, at config module load, and a process has exactly one of them.

import { beforeEach, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || "/tmp"
  process.env.TOKEN_NORM_STATE_DIR = `${tmp}/token-norm-claude-block-${process.pid}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
  process.env.TOKEN_NORM_MODE = "block"
  process.env.TOKEN_NORM_MAX_TOOL_CALLS = "5"
  process.env.TOKEN_NORM_ANNOUNCE_AT = "25"
  process.env.TOKEN_NORM_CHEAP_TOOLS = "todowrite,question,skill"
})

vi.mock("../src/core/log.js", () => ({ log: vi.fn(), logConfigDiagnostics: vi.fn(() => []) }))
vi.mock("../src/core/audit.js", () => ({ runAudit: vi.fn(() => "effective fresh tokens: 123k") }))

import { state } from "../src/core/budget/state.js"
import { handleHook } from "../src/hosts/claude/adapter.js"
import { installStore } from "../src/hosts/claude/main.js"
import type { HookInput, HookOutput } from "../src/hosts/claude/protocol.js"
import type { TranscriptRead } from "../src/usage/claude.js"

const READ: TranscriptRead = {
  source: "measured",
  path: "/tmp/t.jsonl",
  turns: [{ key: "a", sidechain: false, measured: true, tokens: { input: 10, output: 10 } }],
  measuredTurns: 1,
  tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
  latest: { input: 10, output: 10 },
  lines: 1,
  skipped: 0,
  partial: false,
}

function hook(event: string, input: Partial<HookInput> = {}): HookOutput | undefined {
  installStore()
  return handleHook(
    { hook_event_name: event, session_id: "ses_block", tool_name: "read", ...input },
    { read: () => READ },
  )
}

beforeEach(() => {
  installStore()
  state.clear()
})

describe("Claude Code hook adapter, block mode", () => {
  it("allows the call while under the limit", () => {
    for (let i = 0; i < 4; i++) hook("PostToolUse")
    expect(hook("PreToolUse")).toBeUndefined()
  })

  it("denies with permissionDecision once the hard limit is reached", () => {
    for (let i = 0; i < 5; i++) hook("PostToolUse")
    const out = hook("PreToolUse")
    expect(out?.hookSpecificOutput?.hookEventName).toBe("PreToolUse")
    expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny")
    expect(out?.hookSpecificOutput?.permissionDecisionReason).toContain("TOKEN NORM block")
    // The refusal names the way out; a blocked session with no escape is broken.
    expect(out?.hookSpecificOutput?.permissionDecisionReason).toContain("TOKEN_NORM_MODE=warn")
    // Denial rides on permissionDecision, not on the deprecated top-level
    // `decision: "block"` and not on a non-zero exit code.
    expect(out?.hookSpecificOutput?.additionalContext).toBeUndefined()
  })

  it("keeps cheap tools open as the escape hatch", () => {
    for (let i = 0; i < 5; i++) hook("PostToolUse")
    expect(hook("PreToolUse", { tool_name: "todowrite" })).toBeUndefined()
  })

  it("never blocks a session it could not measure", () => {
    for (let i = 0; i < 5; i++) hook("PostToolUse")
    installStore()
    const out = handleHook(
      { hook_event_name: "PreToolUse", session_id: "ses_block", tool_name: "read" },
      {
        read: () => {
          throw new Error("transcript unreadable")
        },
      },
    )
    expect(out).toBeUndefined()
  })
})
