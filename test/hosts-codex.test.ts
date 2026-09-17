import fs from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const dirs = vi.hoisted(() => {
  // No imported binding may be touched in here: vi.hoisted runs before the
  // module's imports are initialised. The directory itself is created lazily by
  // DiskStore (mkdir recursive on first write).
  const tmp = process.env.TMPDIR || "/tmp"
  const root = `${tmp}/token-norm-codex-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  process.env.TOKEN_NORM_STATE_DIR = `${root}/state`
  process.env.TOKEN_NORM_HANDOFF_DIR = `${root}/handoff`
  process.env.TOKEN_NORM_ANNOUNCE_AT = "25"
  process.env.TOKEN_NORM_BOUNDARY_AT = "40"
  process.env.TOKEN_NORM_AUDIT_EVERY = "60"
  process.env.TOKEN_NORM_CHEAP_TOOLS = "todowrite,question,skill"
  // Set and expected to be IGNORED: a rollout records tokens and no prices.
  process.env.TOKEN_NORM_MAX_COST = "5"
  // DELIBERATELY UNSET. Unlike Claude Code, Codex writes `model_context_window`
  // into the rollout, so the context axis must work with no window size in the
  // environment at all (§9e).
  delete process.env.TOKEN_NORM_CONTEXT_LIMIT
  delete process.env.TOKEN_NORM_MODE
  return { root }
})

vi.mock("../src/core/log.js", () => ({ log: vi.fn(), logConfigDiagnostics: vi.fn(() => []) }))
vi.mock("../src/core/audit.js", () => ({ runAudit: vi.fn(() => "effective fresh tokens: 123k") }))

import { state, emptySessionState } from "../src/core/budget/state.js"
import { noteDirFor, notePathFor } from "../src/core/handoff-notes.js"
import { handleHook } from "../src/hosts/codex/adapter.js"
import { hookResponse, installStore } from "../src/hosts/codex/main.js"
import { measureSession } from "../src/hosts/codex/measure.js"
import { resumesContext, type HookInput, type HookOutput } from "../src/hosts/codex/protocol.js"
import { readRollout, type CodexRead } from "../src/usage/codex.js"

const CWD = "/home/u/project-a"
const OTHER = "/home/u/project-b"
const BODY = "done: read the rollout\nnext: wire the adapter\nstate: src/usage/codex.ts is green"
const WINDOW = 258_400

interface Usage {
  input: number
  output: number
  cached?: number
  reasoning?: number
}

let seq = 0

/** A rollout as Codex writes it: `session_meta` on line 0, then one
 * `event_msg`/`token_count` per turn. `total_token_usage` is cumulative and
 * `last_token_usage` is that turn alone, exactly as §9g found in 1237 real
 * records -- so this fixture shares the property the reader depends on rather
 * than the shape a hand-written stub would invent. */
function rollout(opts: { cwd?: string; contextWindow?: number; records?: Usage[] }): string {
  const id = `s${++seq}`
  const file = path.join(
    dirs.root,
    "sessions",
    "2026",
    "09",
    "17",
    `rollout-2026-09-17T10-00-0${seq}-${id}.jsonl`,
  )
  const lines: string[] = []
  lines.push(
    JSON.stringify({
      timestamp: "2026-09-17T06:30:00.000Z",
      type: "session_meta",
      payload: {
        id,
        session_id: id,
        cwd: opts.cwd,
        cli_version: "0.146.0",
        context_window: opts.contextWindow,
      },
    }),
  )
  let cumIn = 0
  let cumOut = 0
  for (const r of opts.records ?? []) {
    cumIn += r.input
    cumOut += r.output
    lines.push(
      JSON.stringify({
        timestamp: "2026-09-17T06:30:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: cumIn,
              cached_input_tokens: 0,
              output_tokens: cumOut,
              reasoning_output_tokens: 0,
              total_tokens: cumIn + cumOut,
            },
            last_token_usage: {
              input_tokens: r.input,
              cached_input_tokens: r.cached ?? 0,
              output_tokens: r.output,
              reasoning_output_tokens: r.reasoning ?? 0,
              total_tokens: r.input + r.output,
            },
            model_context_window: opts.contextWindow,
          },
        },
      }),
    )
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.join("\n") + "\n")
  return file
}

// `cached` is a BREAKDOWN of `input`, not an addend (1237/1237 records, §9g), so
// the fixture has to respect `cached <= input` -- a record with 2000 input and
// 47000 cached cannot exist, and writing one makes the reader's subtraction floor
// at zero. 49000 in with 47000 cached is 2000 fresh plus a 47000-token re-read.
const READ_FILE = rollout({
  cwd: CWD,
  contextWindow: WINDOW,
  records: [{ input: 49_000, output: 1_000, cached: 47_000 }],
})

function read(file = READ_FILE): CodexRead {
  return readRollout({ file })
}

/** One hook invocation as the host makes it: a fresh process, so a fresh store
 * that must load everything it knows from disk. */
function hook(event: string, input: Partial<HookInput> = {}, r: CodexRead = read()): HookOutput | undefined {
  installStore()
  return handleHook(
    { hook_event_name: event, session_id: "ses_codex", tool_name: "read", ...input },
    { read: () => r },
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

function writeNote(cwd: string, body = BODY): string {
  const p = notePathFor(cwd)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  return p
}

beforeEach(() => {
  installStore()
  state.clear()
  fs.rmSync(path.join(dirs.root, "handoff"), { recursive: true, force: true })
})

describe("Codex hook adapter", () => {
  it("delivers the reminder to the MODEL, not to the user", () => {
    const out = post(25)
    // additionalContext is the injection field; systemMessage renders to the
    // human only, so a reminder sent there reaches nobody who can act on it.
    expect(context(out)).toContain("TOKEN NORM")
    expect(out?.hookSpecificOutput?.hookEventName).toBe("PostToolUse")
  })

  it("announces once, not once per call", () => {
    expect(context(post(25))).toContain("TOKEN NORM")
    expect(context(hook("PostToolUse"))).toBe("")
  })

  it("takes the context window from the rollout, not the environment", () => {
    // TOKEN_NORM_CONTEXT_LIMIT is unset for this whole file. On Claude Code that
    // disables the context axis; here the file supplies 258400 and the axis is
    // live, which is §9e's claim in one assertion.
    const m = measureSession("ses_codex", read(), emptySessionState())
    expect(m.contextLimit).toBe(WINDOW)
    expect(m.measured).toBe(true)
    // The window occupancy is the LAST turn, not the cumulative spend: summing
    // cache_read across turns reports a session that never grew as half full.
    const ctx = m.metrics.find((x) => x.key === "context")
    expect(ctx).toBeDefined()
    expect(ctx!.used).toBe(50_000)
  })

  it("omits the cost axis rather than reporting a zero", () => {
    const m = measureSession("ses_codex", read(), emptySessionState())
    expect(m.metrics.some((x) => x.key === "cost")).toBe(false)
  })

  it("degrades to call counting when the rollout has no numbers", () => {
    const file = rollout({ cwd: CWD, records: [] })
    const r = read(file)
    expect(r.source).toBe("counted")
    const m = measureSession("ses_codex", r, emptySessionState())
    expect(m.measured).toBe(false)
    expect(m.metrics.some((x) => x.key === "cost")).toBe(false)
  })
})

describe("Codex SessionStart handoff injection", () => {
  it("resolves cwd from session_meta when the payload carries none", () => {
    // The §9i correction: §9h claimed the hook input has no `cwd` at all, so
    // step 12 could not scope a note. The payload here deliberately has none,
    // and the note is still scoped to the right project.
    const file = rollout({ cwd: CWD, records: [{ input: 10, output: 5 }] })
    writeNote(CWD)
    installStore()
    const out = handleHook({
      hook_event_name: "SessionStart",
      session_id: "ses_codex",
      transcript_path: file,
      source: "startup",
    })
    expect(out?.hookSpecificOutput?.hookEventName).toBe("SessionStart")
    expect(context(out)).toContain("wire the adapter")
    // Delivered to the model, not the operator.
    expect(out?.systemMessage).toBeUndefined()
  })

  it("prefers the payload's cwd when the host does send one", () => {
    const file = rollout({ cwd: OTHER, records: [{ input: 10, output: 5 }] })
    writeNote(CWD)
    installStore()
    const out = handleHook({
      hook_event_name: "SessionStart",
      session_id: "ses_codex",
      transcript_path: file,
      cwd: CWD,
      source: "startup",
    })
    expect(context(out)).toContain("wire the adapter")
  })

  it("delivers a note once and never again", () => {
    const file = rollout({ cwd: CWD, records: [{ input: 10, output: 5 }] })
    const p = writeNote(CWD)
    installStore()
    const start = () =>
      handleHook({ hook_event_name: "SessionStart", session_id: "ses_codex", transcript_path: file, source: "clear" })
    expect(start()).toBeDefined()
    expect(fs.existsSync(p)).toBe(false)
    // Consumed, not destroyed: the agent wrote it and the user may still want it.
    expect(fs.readdirSync(noteDirFor(CWD))).toEqual(["handoff.injected.md"])
    expect(start()).toBeUndefined()
  })

  it("does not inject into a session that already has the context", () => {
    const file = rollout({ cwd: CWD, records: [{ input: 10, output: 5 }] })
    const p = writeNote(CWD)
    installStore()
    for (const source of ["resume", "compact"]) {
      const out = handleHook({
        hook_event_name: "SessionStart",
        session_id: "ses_codex",
        transcript_path: file,
        source,
      })
      expect(out).toBeUndefined()
    }
    // And the note is untouched, so the next real startup still gets it.
    expect(fs.existsSync(p)).toBe(true)
  })

  it("fails closed on a source it has not seen", () => {
    // Codex's own enum is the four below; `fork` is Claude's and must not be
    // assumed to inject just because it appears in the other host's schema.
    expect(resumesContext("startup")).toBe(false)
    expect(resumesContext("clear")).toBe(false)
    expect(resumesContext("resume")).toBe(true)
    expect(resumesContext("compact")).toBe(true)
    expect(resumesContext("fork")).toBe(true)
    expect(resumesContext(undefined)).toBe(true)
  })
})

describe("Codex event surface", () => {
  it("ignores events this host does not have", () => {
    installStore()
    // PostToolUseFailure is a Claude Code event. Codex has no such thing (§9i),
    // so it must resolve to "nothing to say" rather than to an invented branch.
    for (const event of ["PostToolUseFailure", "PermissionRequest", "PreCompact", "SubagentStart"]) {
      expect(handleHook({ hook_event_name: event, session_id: "ses_codex" })).toBeUndefined()
    }
  })

  it("drops the state record on SessionEnd", () => {
    post(3)
    expect(state.get("ses_codex")).toBeDefined()
    hook("SessionEnd")
    expect(state.get("ses_codex")).toBeUndefined()
  })

  it("stays silent and exits zero on an unparsable payload", () => {
    installStore()
    expect(hookResponse("not json")).toBe("")
    expect(hookResponse("")).toBe("")
    // A payload with no session id is nothing to do, not a crash.
    expect(hookResponse(JSON.stringify({ hook_event_name: "PostToolUse" }))).toBe("")
  })
})
