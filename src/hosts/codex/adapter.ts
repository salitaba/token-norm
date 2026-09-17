// The Codex hook adapter: same policy, different plumbing.
//
// opencode runs this plugin in-process and can mutate a tool's output object.
// Codex runs a fresh process per event, hands it JSON on stdin and reads JSON
// from stdout. So the shape of the work changes -- load state from disk, decide,
// write state back, print one JSON object -- while every decision is still made
// by core/budget/policy.ts. Nothing here judges severity.
//
// The mapping, event for event:
//
//   tool.execute.before          -> PreToolUse           (permissionDecision deny)
//   tool.execute.after           -> PostToolUse          (additionalContext)
//   message.updated (user)       -> UserPromptSubmit     (arm task boundary)
//   session.idle / todo.updated  -> Stop                 (arm handoff pause)
//   session.deleted              -> SessionEnd           (drop the record)
//   (no opencode counterpart)    -> SessionStart         (inject the handoff note)
//
// There is no PostToolUseFailure row because Codex has no such event (§9i): a
// failed tool call is still counted here, it just arrives as an ordinary
// PostToolUse. Claude Code's adapter needs a branch for it; this one must not
// grow one.
//
// Every handler returns `undefined` when it has nothing to say, and the runner
// prints nothing at all in that case. A hook that cannot decide must not be a
// hook that breaks the tool call it was watching: the only path that ever
// refuses work is PreToolUse in opt-in block mode.

import { runAudit } from "../../core/audit.js"
import {
  ANNOUNCE_AT,
  AUDIT_EVERY,
  BOUNDARY_AT,
  BUDGET_ENABLED,
  CHEAP_TOOLS,
  MODE,
} from "../../core/config.js"
import { blockMessage, budgetSection, takeCrossings } from "../../core/budget/evaluator.js"
import { note } from "../../core/budget/format.js"
import {
  evaluatePolicy,
  maxState,
  ordinal,
  renderPolicy,
  type PolicySections,
} from "../../core/budget/policy.js"
import {
  announceReminder,
  auditReminder,
  boundaryReminder,
  handoffLines,
} from "../../core/budget/reminders.js"
import { consumeHandoffNote, notePathFor, readHandoffNote } from "../../core/handoff-notes.js"
import { emptySessionState, state, topTools, track, type SessionState } from "../../core/budget/state.js"
import { log } from "../../core/log.js"
import { readRollout, type CodexRead } from "../../usage/codex.js"
import { measureSession, transcriptAudit } from "./measure.js"
import {
  denyToolCall,
  hookEventOf,
  injectContext,
  resumesContext,
  type CodexHookEvent,
  type HookInput,
  type HookOutput,
} from "./protocol.js"

/** The handoff tool is opencode-only; on this host the escape hatch from block
 * mode is the cheap-tool list plus ending the session. */
const CHEAP_ALWAYS_ALLOWED = CHEAP_TOOLS

export interface AdapterDeps {
  /** Injected so tests can drive the adapter without a rollout on disk, and so
   * a future host reader can be swapped in without touching the policy. */
  read?: (input: HookInput) => CodexRead
  /** The audit payload for the checkpoint section. */
  audit?: (read: CodexRead, sessionId: string) => string
}

function readFor(input: HookInput): CodexRead {
  // `transcript_path` is handed to us by the host, so the id-glob in
  // usage/codex.ts is a fallback, not the main path.
  return readRollout({ file: input.transcript_path, sessionId: input.session_id })
}

/** Enough of the rollout to reach `session_meta`, which is line 0. The reader
 * always takes its head before its tail, so a small cap still yields `cwd` --
 * it only shortens the tail, which this call does not want. */
const META_READ_BYTES = 256 * 1024

/** Which project this session belongs to.
 *
 * §9h concluded the hook input carries no `cwd`; §9i found it in at least the
 * PreToolUse-shaped struct, and no input schema exists in the binary to settle
 * the session-level events. So the payload is preferred when it is there and the
 * rollout's own `session_meta.cwd` is the fallback -- correct under both
 * readings, and it also covers a `cwd` that is present but stale, since the
 * transcript records where the session actually ran.
 *
 * A read failure is not an error here: an unresolvable cwd means no note is
 * injected, which is the safe direction. */
function cwdFor(input: HookInput): string | undefined {
  if (input.cwd) return input.cwd
  try {
    return readRollout({
      file: input.transcript_path,
      sessionId: input.session_id,
      maxBytes: META_READ_BYTES,
    }).cwd
  } catch {
    return undefined
  }
}

/** usage-audit.py reads opencode's sqlite db and has nothing to say about a
 * Codex session, so the numbers come from the rollout instead. `runAudit` stays
 * reachable via TOKEN_NORM_AUDIT_SCRIPT for anyone pointing it at a reader of
 * their own. */
function auditFor(read: CodexRead, sessionId: string): string {
  const fromRollout = transcriptAudit(read)
  if (read.source === "measured") return fromRollout
  const fallback = runAudit(sessionId)
  return fallback.startsWith("(usage-audit did not run") ? fromRollout : fallback
}

/** PostToolUse: count the call, then decide whether anything is due.
 *
 * A line-for-line sibling of `tool.execute.after` in budget/plugin.ts, and
 * deliberately so -- the section set, their order and their latches are the
 * behaviour being ported. The differences are that the numbers arrive from the
 * rollout rather than from live events, and that the result is returned as
 * `additionalContext` instead of appended to a mutable output object. */
function onPostToolUse(
  event: CodexHookEvent,
  input: HookInput,
  sessionId: string,
  deps: AdapterDeps,
): HookOutput | undefined {
  const tool = input.tool_name ?? "unknown"
  let s: SessionState
  try {
    s = track(sessionId, tool)
  } catch {
    return undefined
  }

  try {
    // A pause is spent by the next tool call whether or not it fires, exactly
    // as in the opencode hook: the model has resumed work, so the quiet moment
    // the recommendation was meant to ride on has passed.
    const pauseArmed = s.pendingHandoff
    s.pendingHandoff = false

    const read = (deps.read ?? readFor)(input)
    const { metrics, measured } = measureSession(sessionId, read, s)
    const verdict = evaluatePolicy({ calls: s.calls, metrics, mode: MODE, pauseArmed })
    const previous = s.level
    const level = maxState(previous, verdict.state)
    const rose = ordinal(level) > ordinal(previous)
    s.level = level
    for (const axis of Object.values(verdict.axes)) s.axisLevels[axis.name] = axis.state

    const sections: PolicySections = {}

    if (s.pendingBoundary) {
      s.pendingBoundary = false
      sections.boundary = boundaryReminder(s.calls)
    }

    if (!s.announced && s.calls >= ANNOUNCE_AT) {
      s.announced = true
      log(`${sessionId} announce-threshold at ${s.calls} calls (${topTools(s)})`)
      sections.announce = announceReminder(s.calls, topTools(s))
    }

    if (s.calls > 0 && s.calls - s.lastAudit >= AUDIT_EVERY) {
      s.lastAudit = s.calls
      log(`${sessionId} audit-threshold at ${s.calls} calls (${topTools(s)})`)
      sections.audit = auditReminder(s.calls, (deps.audit ?? auditFor)(read, sessionId))
    }

    const crossed = takeCrossings(sessionId, s, metrics)
    if (crossed.length > 0 && MODE !== "observe") {
      sections.budget = budgetSection(metrics, crossed)
      if (!measured) {
        sections.budget.push(
          `Token figures are UNMEASURED on this call (rollout ${read.source}); the call count is not.`,
        )
      }
    }

    if (verdict.state === "HANDOFF_RECOMMENDED") {
      log(`${sessionId} handoff recommended at ${s.calls} calls (${verdict.driver.detail})`)
      sections.handoff = handoffLines(sessionId, handoffClosing(cwdFor(input)))
    }

    const lines = renderPolicy(verdict, s.calls, sections)
    if (!lines) return undefined
    const output = injectContext(event, note(lines).trimStart())
    // The user-facing half of the toast opencode shows. `systemMessage` renders
    // to the human and nothing else, so it carries the severity only -- the
    // instructions live in additionalContext, where the model can act on them.
    if (rose || sections.handoff) output.systemMessage = `Token norm: ${level} (${s.calls} calls)`
    return output
  } catch {
    /* the policy pass is advisory; never break a tool call */
    return undefined
  } finally {
    // The disk store writes here and nowhere else. Without this the increment
    // in `track` survives but every latch set above is lost, so the session
    // re-announces and re-audits forever. See docs/multi-host-port.md 8a.
    state.save(sessionId)
  }
}

/** PreToolUse: the only path that refuses work, and only in opt-in block mode.
 * `tool_name` is on this event's input struct (§9i), so the cheap-tool gate and
 * the deny path are the same code as on Claude Code. */
function onPreToolUse(input: HookInput, sessionId: string, deps: AdapterDeps): HookOutput | undefined {
  if (MODE !== "block") return undefined
  const tool = input.tool_name ?? "unknown"
  if (CHEAP_ALWAYS_ALLOWED.has(tool)) return undefined
  try {
    const s = state.get(sessionId)
    const read = (deps.read ?? readFor)(input)
    // A session the store has never seen measures as zero rather than as a
    // missing record: this is the gate in front of its FIRST call.
    const { metrics } = measureSession(sessionId, read, s ?? emptySessionState())
    const verdict = evaluatePolicy({
      calls: s?.calls ?? 0,
      metrics,
      mode: MODE,
      pauseArmed: s?.pendingHandoff ?? false,
    })
    if (verdict.state !== "BLOCKED") return undefined
    return denyToolCall(blockMessage(metrics))
  } catch {
    // An unmeasurable session is never blocked: refusing work on a number we
    // could not read would strand the session on our own bug.
    return undefined
  }
}

/** UserPromptSubmit: the task boundary.
 *
 * No dedupe by message id here, unlike the opencode `message.updated` handler
 * which fires many times for one message and once injected this reminder 61
 * times in a single session. UserPromptSubmit fires once per submission, so the
 * event itself is the dedupe. */
function onUserPromptSubmit(sessionId: string): HookOutput | undefined {
  const s = state.get(sessionId)
  if (!s || s.calls < BOUNDARY_AT) return undefined
  if (s.pendingBoundary) return undefined
  s.pendingBoundary = true
  state.save(sessionId)
  log(`${sessionId} task-boundary at ${s.calls} calls (prompt submitted)`)
  return undefined
}

/** Stop: arm the pause a handoff may ride on.
 *
 * Nothing is injected here even though the host would allow it. Injecting on
 * Stop resumes the conversation, so a recommendation delivered here restarts
 * the very session it is asking to end. The flag is read on the next tool
 * call, which is where opencode surfaces it too. */
function onStop(sessionId: string): HookOutput | undefined {
  if (MODE !== "handoff") return undefined
  const s = state.get(sessionId)
  if (!s || s.pendingHandoff) return undefined
  s.pendingHandoff = true
  state.save(sessionId)
  log(`${sessionId} pause observed (handoff armed pending pressure)`)
  return undefined
}

/** The opencode skeleton ends with "call the handoff tool". That tool cannot
 * exist here -- it opens the new session itself, and no hook can start one --
 * so on this host the instruction has to name the two steps the user drives
 * instead. Left unchanged it would send an over-budget session to spend a turn
 * calling a tool that is not there, which is the worst moment to do it.
 *
 * Claude Code's closing says `/clear`; §9c is explicit that Codex's must not,
 * because there is no `/clear` here -- the equivalent is quitting and starting a
 * fresh `codex`, which is also what re-triggers the SessionStart injection. */
function handoffClosing(cwd: string | undefined): string[] {
  if (!cwd) {
    return [`  3. Write the 3-line handoff into a NOTES file, then start a fresh \`codex\`.`]
  }
  return [
    `  3. Write the handoff to ${notePathFor(cwd)} (create the directory), then start a fresh`,
    `     \`codex\`. This host cannot open a session from a hook, so SessionStart injects that`,
    `     note into the next session instead -- the split costs one write and one restart.`,
  ]
}

/** SessionStart: hand the fresh session the note the previous one left.
 *
 * The other half of the degraded split. Only `startup` and `clear` are injected
 * into: `resume` and `compact` already hold the context the note describes, and
 * on `compact` the note would re-inject exactly what compaction ran to discard
 * (see `resumesContext`).
 *
 * Injection is scoped to the session's own cwd, so a note is never read into a
 * different repo, and a session with no resolvable cwd gets nothing rather than
 * getting somebody else's note. */
function onSessionStart(input: HookInput, sessionId: string): HookOutput | undefined {
  if (resumesContext(input.source)) return undefined
  const cwd = cwdFor(input)
  if (!cwd) return undefined
  const found = readHandoffNote(cwd)
  if (!found) return undefined
  // Marked before it is delivered, not after. If the rename fails, the choice
  // is between delivering this note once-or-never and delivering it at the
  // start of every future session in this project; a note that never arrives is
  // still on disk and recoverable by hand, one that arrives forever is not.
  if (!consumeHandoffNote(found.path)) {
    log(`${sessionId} handoff note ${found.path} could not be consumed; not injecting`)
    return undefined
  }
  log(`${sessionId} injected handoff note from ${found.path} (source=${input.source ?? "none"})`)
  return injectContext(
    "SessionStart",
    note([
      `TOKEN NORM -- HANDOFF FROM THE PREVIOUS SESSION.`,
      `The previous session hit budget pressure and wrote this note for you. It is`,
      `the task: nothing else from that session carried over. Start from it rather`,
      `than re-deriving what it already found.`,
      `The note has been consumed and will not be injected again.`,
      ``,
      found.body,
    ]).trimStart(),
  )
}

/** SessionEnd: drop the record.
 *
 * On opencode the counters are in memory and die with the process. Here they
 * are a file per session, so without this the state directory grows by one file
 * per session forever. */
function onSessionEnd(sessionId: string): HookOutput | undefined {
  state.delete(sessionId)
  return undefined
}

/** Dispatch. Never throws: an unparsable payload, an unknown event or a missing
 * session id all resolve to "nothing to say". */
export function handleHook(input: HookInput | undefined, deps: AdapterDeps = {}): HookOutput | undefined {
  if (!BUDGET_ENABLED) return undefined
  const event = hookEventOf(input)
  if (!event || !input) return undefined
  const sessionId = input.session_id
  if (!sessionId) return undefined

  switch (event) {
    case "PostToolUse":
      return onPostToolUse(event, input, sessionId, deps)
    case "PreToolUse":
      return onPreToolUse(input, sessionId, deps)
    case "UserPromptSubmit":
      return onUserPromptSubmit(sessionId)
    case "Stop":
      return onStop(sessionId)
    case "SessionEnd":
      return onSessionEnd(sessionId)
    case "SessionStart":
      return onSessionStart(input, sessionId)
  }
}
