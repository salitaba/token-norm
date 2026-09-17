// The Claude Code hook adapter: same policy, different plumbing.
//
// opencode runs this plugin in-process and can mutate a tool's output object.
// Claude Code runs a fresh process per event, hands it JSON on stdin and reads
// JSON from stdout. So the shape of the work changes -- load state from disk,
// decide, write state back, print one JSON object -- while every decision is
// still made by core/budget/policy.ts. Nothing here judges severity.
//
// The mapping, event for event:
//
//   tool.execute.before          -> PreToolUse           (permissionDecision deny)
//   tool.execute.after           -> PostToolUse          (additionalContext)
//   message.updated (user)       -> UserPromptSubmit     (arm task boundary)
//   session.idle / todo.updated  -> Stop                 (arm handoff pause)
//   session.deleted              -> SessionEnd           (drop the record)
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
import { emptySessionState, state, topTools, track, type SessionState } from "../../core/budget/state.js"
import { log } from "../../core/log.js"
import { readTranscript, type TranscriptRead } from "../../usage/claude.js"
import { measureSession, transcriptAudit } from "./measure.js"
import {
  denyToolCall,
  hookEventOf,
  injectContext,
  type ClaudeHookEvent,
  type HookInput,
  type HookOutput,
} from "./protocol.js"

/** The handoff tool is opencode-only; on this host the escape hatch from block
 * mode is the cheap-tool list plus ending the session. */
const CHEAP_ALWAYS_ALLOWED = CHEAP_TOOLS

export interface AdapterDeps {
  /** Injected so tests can drive the adapter without a transcript on disk, and
   * so a future host reader can be swapped in without touching the policy. */
  read?: (input: HookInput) => TranscriptRead
  /** The audit payload for the checkpoint section. */
  audit?: (read: TranscriptRead, sessionId: string) => string
}

function readFor(input: HookInput): TranscriptRead {
  // `transcript_path` is handed to us by the host, so the project-slug
  // derivation in usage/claude.ts is a fallback, not the main path.
  return readTranscript({
    file: input.transcript_path,
    sessionId: input.session_id,
    cwd: input.cwd,
  })
}

/** usage-audit.py reads opencode's sqlite db and has nothing to say about a
 * Claude session, so the numbers come from the transcript instead. `runAudit`
 * stays reachable via TOKEN_NORM_AUDIT_SCRIPT for anyone pointing it at a
 * reader of their own. */
function auditFor(read: TranscriptRead, sessionId: string): string {
  const fromTranscript = transcriptAudit(read)
  if (read.source === "measured") return fromTranscript
  const fallback = runAudit(sessionId)
  return fallback.startsWith("(usage-audit did not run") ? fromTranscript : fallback
}

/** PostToolUse: count the call, then decide whether anything is due.
 *
 * A line-for-line sibling of `tool.execute.after` in budget/plugin.ts, and
 * deliberately so -- the section set, their order and their latches are the
 * behaviour being ported. The differences are that the numbers arrive from the
 * transcript rather than from live events, and that the result is returned as
 * `additionalContext` instead of appended to a mutable output object. */
function onPostToolUse(
  event: ClaudeHookEvent,
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
          `Token figures are UNMEASURED on this call (transcript ${read.source}); the call count is not.`,
        )
      }
    }

    if (verdict.state === "HANDOFF_RECOMMENDED") {
      log(`${sessionId} handoff recommended at ${s.calls} calls (${verdict.driver.detail})`)
      sections.handoff = handoffLines(sessionId)
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

/** PreToolUse: the only path that refuses work, and only in opt-in block mode. */
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

/** SessionEnd: drop the record.
 *
 * On opencode the counters are in memory and die with the process. Here they
 * are a file per session, so without this the state directory grows by one
 * file per session forever. */
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
    // A failed tool call still spent tokens, so it is counted -- but nothing is
    // injected, because the model is already reading an error and a reminder
    // stapled to a failure reads as part of the failure.
    case "PostToolUseFailure": {
      try {
        track(sessionId, input.tool_name ?? "unknown")
      } catch {
        /* counting is best-effort */
      }
      return undefined
    }
    case "PreToolUse":
      return onPreToolUse(input, sessionId, deps)
    case "UserPromptSubmit":
      return onUserPromptSubmit(sessionId)
    case "Stop":
      return onStop(sessionId)
    case "SessionEnd":
      return onSessionEnd(sessionId)
  }
}
