// Pins the one line that makes a disk backend work at all.
//
// budget/plugin.ts mutates the SessionState it gets back from `track`, and on
// the in-memory backend that IS the stored object, so nothing needed writing.
// On a disk backend `set` only stages and `save` is the sole writer, so a
// handler that returns without saving loses every latch it just set: the
// session re-announces on every call, re-runs the audit forever, and re-arms
// crossings it already paid for. `track` saves the increment, which is why
// `calls` alone cannot detect this -- these assertions are all on fields
// written AFTER it.
//
// docs/multi-host-port.md 8a calls this the single most likely way to wire a
// hook adapter up and have it silently count nothing.

import { beforeEach, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  process.env.TOKEN_NORM_ANNOUNCE_AT = "25"
  process.env.TOKEN_NORM_BOUNDARY_AT = "40"
  process.env.TOKEN_NORM_AUDIT_EVERY = "60"
  process.env.TOKEN_NORM_CHEAP_TOOLS = "todowrite,question,skill"
  process.env.TOKEN_NORM_MODE = "handoff"
})

vi.mock("../src/core/log.js", () => ({ log: vi.fn(), logConfigDiagnostics: vi.fn(() => []) }))
vi.mock("../src/core/audit.js", () => ({ runAudit: vi.fn(() => "effective fresh tokens: 123k") }))

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { setStateStore, stateCodec, state, type SessionState } from "../src/core/budget/state.js"
import { DiskStore } from "../src/runtime/store.js"
import { SessionBudgetPlugin } from "../src/session-budget.js"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-norm-plugin-"))
const hooks = await SessionBudgetPlugin({} as never)

/** A store with an empty working set, i.e. what a later reader sees: only what
 * actually reached the disk. */
function reopen(): DiskStore<SessionState> {
  const store = new DiskStore<SessionState>(dir, stateCodec)
  setStateStore(store)
  return store
}

async function callTool(sessionID: string, tool = "read"): Promise<string> {
  const output = { title: "t", output: "tool output", metadata: {} }
  await hooks["tool.execute.after"]!({ tool, sessionID, callID: "call_1", args: {} }, output)
  return output.output
}

beforeEach(() => {
  reopen()
  state.clear()
})

describe("budget plugin on a disk backend", () => {
  it("persists the announce latch, so it does not re-fire on every later call", async () => {
    let last = ""
    for (let i = 0; i < 25; i++) last = await callTool("ses_disk")
    expect(last).toContain("TOKEN NORM")

    expect(reopen().get("ses_disk")?.announced).toBe(true)
    // The real symptom of a missing save: the reminder every call forever.
    expect(await callTool("ses_disk")).not.toContain("TOKEN NORM")
  })

  it("persists the task boundary armed by a user message", async () => {
    for (let i = 0; i < 40; i++) await callTool("ses_boundary")
    await hooks.event!({
      event: { type: "message.updated", properties: { info: { id: "msg_1", role: "user", sessionID: "ses_boundary" } } },
    } as never)

    expect(reopen().get("ses_boundary")?.pendingBoundary).toBe(true)
    expect(await callTool("ses_boundary")).toContain("TASK BOUNDARY")
    // Consumed, and the consumption persisted too -- otherwise a reload
    // resurrects a spent flag and injects the reminder twice.
    expect(reopen().get("ses_boundary")?.pendingBoundary).toBe(false)
  })

  it("persists the handoff pause armed by an idle event", async () => {
    await callTool("ses_pause")
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_pause" } } } as never)
    expect(reopen().get("ses_pause")?.pendingHandoff).toBe(true)
  })

  it("persists the session high-water level", async () => {
    for (let i = 0; i < 25; i++) await callTool("ses_level")
    const stored = reopen().get("ses_level")
    expect(stored?.level).not.toBe("HEALTHY")
    expect(stored?.lastAudit).toBe(0)
  })
})
