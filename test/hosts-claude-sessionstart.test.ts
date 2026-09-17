import fs from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const dirs = vi.hoisted(() => {
  const tmp = process.env.TMPDIR || "/tmp"
  const root = `${tmp}/token-norm-ss-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  process.env.TOKEN_NORM_STATE_DIR = `${root}/state`
  process.env.TOKEN_NORM_HANDOFF_DIR = `${root}/handoff`
  process.env.TOKEN_NORM_ANNOUNCE_AT = "25"
  delete process.env.TOKEN_NORM_MODE
  return { root }
})

vi.mock("../src/core/log.js", () => ({ log: vi.fn(), logConfigDiagnostics: vi.fn(() => []) }))
vi.mock("../src/core/audit.js", () => ({ runAudit: vi.fn(() => "audit") }))

import { handoffLines } from "../src/core/budget/reminders.js"
import { NOTE_TTL_MS, noteDirFor, notePathFor } from "../src/core/handoff-notes.js"
import { handleHook } from "../src/hosts/claude/adapter.js"
import { resumesContext } from "../src/hosts/claude/protocol.js"

const CWD = "/home/u/project-a"
const OTHER = "/home/u/project-b"
const BODY = "done: read the transcript\nnext: wire the adapter\nstate: src/usage/claude.ts is green"

function writeNote(cwd: string, body = BODY, ageMs = 0): string {
  const p = notePathFor(cwd)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  if (ageMs > 0) {
    const secs = (Date.now() - ageMs) / 1000
    fs.utimesSync(p, secs, secs)
  }
  return p
}

function start(source: string | undefined, cwd: string | undefined = CWD) {
  return handleHook({ hook_event_name: "SessionStart", session_id: "s1", source, cwd })
}

beforeEach(() => {
  fs.rmSync(path.join(dirs.root, "handoff"), { recursive: true, force: true })
})

describe("SessionStart handoff injection", () => {
  it("injects the note on a cleared session, in additionalContext", () => {
    writeNote(CWD)
    const out = start("clear")
    expect(out?.hookSpecificOutput?.hookEventName).toBe("SessionStart")
    expect(out?.hookSpecificOutput?.additionalContext).toContain("wire the adapter")
    // The reminder must reach the model, not the operator: systemMessage is
    // user-visible only, so a handoff delivered there would be invisible here.
    expect(out?.systemMessage).toBeUndefined()
  })

  it("injects on a fresh startup too", () => {
    writeNote(CWD)
    expect(start("startup")?.hookSpecificOutput?.additionalContext).toContain("wire the adapter")
  })

  it("delivers a note once and never again", () => {
    const p = writeNote(CWD)
    expect(start("clear")).toBeDefined()
    expect(fs.existsSync(p)).toBe(false)
    // Consumed, not destroyed: the agent wrote it and the user may still want it.
    expect(fs.readdirSync(noteDirFor(CWD))).toEqual(["handoff.injected.md"])
    expect(start("clear")).toBeUndefined()
  })

  it.each(["resume", "fork", "compact"])("does not inject on %s, and leaves the note", (source) => {
    const p = writeNote(CWD)
    expect(start(source)).toBeUndefined()
    expect(fs.existsSync(p)).toBe(true)
  })

  it("fails closed on a source it has never seen", () => {
    writeNote(CWD)
    expect(start("some-future-source")).toBeUndefined()
    expect(start(undefined)).toBeUndefined()
    expect(resumesContext("some-future-source")).toBe(true)
  })

  it("never reads another project's note", () => {
    writeNote(OTHER)
    expect(start("clear", CWD)).toBeUndefined()
    expect(fs.existsSync(notePathFor(OTHER))).toBe(true)
  })

  it("ignores a note with no cwd to scope it to", () => {
    writeNote(CWD)
    // Built without the key rather than with `cwd: undefined`, which a default
    // parameter would quietly replace with a real directory.
    expect(handleHook({ hook_event_name: "SessionStart", session_id: "s1", source: "clear" })).toBeUndefined()
  })

  it("treats a note older than the TTL as absent", () => {
    writeNote(CWD, BODY, NOTE_TTL_MS + 60_000)
    expect(start("clear")).toBeUndefined()
  })

  it("ignores an empty note", () => {
    writeNote(CWD, "   \n  ")
    expect(start("clear")).toBeUndefined()
  })
})

describe("the handoff skeleton's last step", () => {
  it("still tells opencode to call the handoff tool", () => {
    expect(handoffLines("s1").join("\n")).toContain("Call the handoff tool")
  })

  it("can be replaced for a host that has no such tool", () => {
    const lines = handoffLines("s1", ["  3. Write the note, then run /clear."]).join("\n")
    expect(lines).toContain("run /clear")
    // The bug this guards: on Claude Code there is no handoff tool, so the
    // unmodified skeleton sent an over-budget session to call a tool that does
    // not exist.
    expect(lines).not.toContain("Call the handoff tool")
  })
})
