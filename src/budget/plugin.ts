// Session budget enforcement (always-on, all projects).
//
// WHY THIS EXISTS
// A token norm written into AGENTS.md loads into every session and is still
// broken, because the rules that survive are the ones that do not depend on the
// agent choosing to follow them. Capping bash output works every time because a
// plugin rewrites the command and nobody has to remember it. The two rules with
// no mechanism -- "announce the cost before a big task" and "run the audit
// midway" -- were the exact two that failed in a 184-call, 3.0M effective-token
// session where the norm was in context the whole time.
//
// So this plugin does not rely on agent-authored advice as its enforcement
// mechanism. It counts, and at thresholds it staples a notice onto tool output
// the agent is already reading. An instruction the agent cannot skip past beats
// an instruction it merely has.
//
// It never edits args and, outside opt-in `block` mode, never fails a tool
// call: a wrong guess here must cost a few lines of text, not a broken session.

import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { runAudit } from "../core/audit.js"
import { asNormEvent, type BudgetClient, type NormEvent, type ToastClient } from "../core/host.js"
import { log, logConfigDiagnostics } from "../core/log.js"
import { ANNOUNCE_AT, AUDIT_EVERY, BOUNDARY_AT, CHEAP_TOOLS, MAX_COST, MAX_EFFECTIVE_TOKENS, MODE } from "../core/config.js"
import { blockMessage, budgetSection, contextLimitFor, measure, takeCrossings } from "../core/budget/evaluator.js"
import { note } from "../core/budget/format.js"
import { evaluatePolicy, maxState, ordinal, renderPolicy, type PolicySections, type PolicyState } from "../core/budget/policy.js"
import {
  announceReminder,
  auditReminder,
  boundaryReminder,
  compactionContext,
  handoffLines,
} from "../core/budget/reminders.js"
import { SEEN_MESSAGES_MAX, state, topTools, track, usage, type SessionState } from "../core/budget/state.js"
import { createStatusTool, snapshotFrom, type StatusProvider } from "../status.js"

const HANDOFF_TOOL = "handoff"

function toast(client: ToastClient | undefined, message: string): void {
  try {
    Promise.resolve(
      client?.tui?.showToast?.({ body: { title: "Token norm", message, variant: "warning" } }),
    ).catch(() => {})
  } catch {
    /* a toast is decoration; never let it break the tool call */
  }
}

/** The two pauses a handoff may ride on: the session went idle, or every todo
 * is complete. The model has stopped, so a recommendation does not interrupt
 * work in flight. */
function pauseSessionID(event: NormEvent | undefined): string | undefined {
  const id = event?.properties?.sessionID
  if (typeof id !== "string") return undefined
  if (event?.type === "session.idle") return id
  if (event?.type !== "todo.updated") return undefined
  const todos = event.properties?.todos
  const done = Array.isArray(todos) && todos.length > 0 && todos.every((t) => t?.status === "completed")
  return done ? id : undefined
}

// The host passes a full client; this plugin declares only the calls it makes.
// The default exists so the plugin can be constructed with no input at all --
// a client is never required, and every call site already guards for it.
type BudgetPluginInput = Partial<Omit<PluginInput, "client">> & { client?: BudgetClient }

export const SessionBudgetPlugin: Plugin = async ({ client }: BudgetPluginInput = {}) => {
  // A misspelled or malformed setting otherwise fails silently into the
  // default, so the user believes a budget is in force that is not. Toast it
  // too: a line in a log file nobody opens is the same as no report.
  const problems = logConfigDiagnostics()
  if (problems.length > 0) toast(client, problems.join("\n"))

  // The status tool must answer from the same accumulators that enforce the
  // budget, so the closure that owns `state` and `usage` is injected into the
  // tool factory. A module-global reader would let a second plugin instance in
  // the same process shadow this one; injection keeps the binding per instance.
  const statusProvider: StatusProvider = async (sessionID) => {
    const { metrics, rollup, contextLimit } = await measure(client, sessionID)
    const s = state.get(sessionID)
    // The status tool answers from the SAME machine the hook enforces with, so
    // it can no longer report "continue" while a reminder is being injected.
    // It reads without latching: asking where the session stands must not
    // consume a crossing or advance the stored level.
    const verdict = evaluatePolicy({
      calls: s?.calls ?? 0,
      metrics,
      mode: MODE,
      pauseArmed: s?.pendingHandoff ?? false,
    })
    return snapshotFrom({
      toolCalls: rollup.weightedCalls,
      context: usage.has(sessionID) ? usage.get(sessionID).contextNow : 0,
      contextLimit,
      cost: { used: rollup.costUsd, limit: MAX_COST },
      effectiveTokens: { used: rollup.effectiveTokens, limit: MAX_EFFECTIVE_TOKENS },
      // Two readings, deliberately not one: the verdict is this instant and can
      // fall, s.level is the session high-water mark and cannot. Collapsing
      // them (as the old single `state` did) meant a session that recovered
      // still read PRESSURE with no way to tell recovery from ongoing trouble.
      current: verdict.state,
      peak: maxState(verdict.state, s?.level ?? "HEALTHY"),
      driver: verdict.driver.name,
    })
  }

  return {
    // On-demand accounting for exactly the numbers the thresholds below use.
    // Read-only, no args, and a no-op (zeros) for unknown sessions.
    tool: {
      token_norm_status: createStatusTool(statusProvider),
    },

    // A new user message in an already-large session is the task boundary the
    // norm cares about most, and the one with no mechanism until now. In a
    // 195k-token session the agent had the rule in context, ran the audit,
    // reported "77x cache, bloat HIGH" -- and then continued anyway, because a
    // second task ("do all of them") was treated as a continuation of the
    // "do everything" override granted for the first. Overrides are per-task;
    // nothing enforced that. This fires on the NEXT tool call after such a
    // message, which is the earliest point the agent cannot skip past.
    event: async (input) => {
      try {
        const event = asNormEvent(input?.event)
        usage.handleEvent(event)

        // Handoff mode: a pause is recorded here; whether it becomes a
        // recommendation is the policy machine's call on the next tool call,
        // not a second pressure test in this hook. Events cannot append to
        // tool output, so this flag is the only thing an event can do.
        const pauseID = MODE === "handoff" ? pauseSessionID(event) : undefined
        if (pauseID) {
          const paused = state.get(pauseID)
          if (paused && !paused.pendingHandoff) {
            paused.pendingHandoff = true
            log(`${pauseID} pause observed (handoff armed pending pressure)`)
          }
        }

        // Counters are in-memory and keyed by session, so without this a
        // long-lived server would accumulate one entry per session ever
        // opened. The session is gone; keeping its score buys nothing.
        if (event?.type === "session.deleted") {
          // Guarded rather than assumed: an event missing `info.id` used to
          // throw into the catch below, which silently skipped the handoff
          // arming and boundary logic for that event too.
          const deletedID = event.properties?.info?.id
          if (deletedID) state.delete(deletedID)
          return
        }
        if (event?.type !== "message.updated") return
        const info = event.properties?.info
        if (info?.role !== "user" || !info.sessionID) return
        const s = state.get(info.sessionID)
        if (!s || s.calls < BOUNDARY_AT) return
        // Dedupe on MESSAGE IDENTITY, not on call count.
        //
        // `message.updated` fires many times for the SAME user message (it is
        // an update event: streaming, metadata, revisions). An earlier guard
        // compared `boundaryAt === s.calls`, but `s.calls` increments on every
        // tool call, so it went stale after one tool call and re-armed. One
        // live session fired this reminder 61 times for a single user message
        // -- on nearly every tool call for the rest of the session.
        //
        // That is worse than not firing at all. A warning that repeats on
        // every tool call becomes wallpaper, and the agent learns to skip ALL
        // system-reminders -- including the audit checkpoint, which in that
        // same session was ignored precisely because it arrived buried in the
        // 61st copy of this one. Cry wolf once per wolf.
        if (!info.id || s.seenMessages.has(info.id)) return
        s.seenMessages.add(info.id)
        if (s.seenMessages.size > SEEN_MESSAGES_MAX) {
          const oldest = s.seenMessages.values().next().value
          if (oldest !== undefined) s.seenMessages.delete(oldest)
        }
        s.pendingBoundary = true
        log(`${info.sessionID} task-boundary at ${s.calls} calls (msg ${info.id})`)
      } catch {
        /* a missed boundary must never break the session */
      }
    },

    "tool.execute.after": async (input, output) => {
      let s: SessionState
      try {
        s = track(input.sessionID, input.tool)
      } catch {
        return
      }

      try {
        usage.noteToolCall(input.sessionID, input.tool, input.args, output, !CHEAP_TOOLS.has(input.tool))
      } catch {
        /* measurement must never break a tool call */
      }

      // ONE evaluation, ONE block, at most one toast.
      //
      // This used to be four independent `if`s, two of which returned early.
      // That made the reminders compete: a task boundary suppressed the audit,
      // an announce suppressed a budget crossing, and when three did land
      // together the tool result carried three separate <system-reminder>
      // blocks. Both failures teach the same lesson to the agent -- that these
      // notices are noise to be skimmed -- which is precisely what the
      // boundary reminder's own dedupe logic exists to prevent. So everything
      // due on this call is now collected into one block with a fixed section
      // order, and nothing is dropped to make room for anything else.
      try {
        // A pause is spent by the next tool call whether or not it fires. The
        // model has resumed work, so the pause is no longer the quiet moment
        // the recommendation was meant to ride on; leaving the flag armed
        // would let a handoff surface mid-task the instant pressure arrived.
        const pauseArmed = s.pendingHandoff
        s.pendingHandoff = false

        const { metrics } = await measure(client, input.sessionID)
        const verdict = evaluatePolicy({ calls: s.calls, metrics, mode: MODE, pauseArmed })
        const previous = s.level
        const level = maxState(previous, verdict.state)
        const rose = ordinal(level) > ordinal(previous)
        s.level = level
        for (const axis of Object.values(verdict.axes)) s.axisLevels[axis.name] = axis.state

        const sections: PolicySections = {}

        // Section 1 -- task boundary. First because acting on it avoids the
        // spend the others only measure after the fact.
        if (s.pendingBoundary) {
          s.pendingBoundary = false
          sections.boundary = boundaryReminder(s.calls)
        }

        // Section 2 -- the startup reflex, fired late but before the bulk of
        // the spend. The norm wants it BEFORE the work; in practice the agent
        // only discovers the true size once underway, so it lands at the first
        // moment the task is provably "big".
        if (!s.announced && s.calls >= ANNOUNCE_AT) {
          s.announced = true
          log(`${input.sessionID} announce-threshold at ${s.calls} calls (${topTools(s)})`)
          sections.announce = announceReminder(s.calls, topTools(s))
        }

        // Section 3 -- the midway audit. Recurring, because the norm's real
        // failure mode is a session that quietly runs 3x past where a split
        // should have happened.
        if (s.calls > 0 && s.calls - s.lastAudit >= AUDIT_EVERY) {
          s.lastAudit = s.calls
          log(`${input.sessionID} audit-threshold at ${s.calls} calls (${topTools(s)})`)
          // Run the audit HERE rather than asking the agent to run it.
          //
          // "Run this command and report the number" is advice, and advice at
          // a checkpoint loses to the task in flight every time: one session
          // was told to audit at call 79, kept working, and produced the
          // number only when the user asked afterwards. The command is cheap,
          // deterministic and read-only, so the plugin runs it and staples the
          // RESULT on. The agent then has the number in hand and no step to
          // defer -- only a fact to report.
          sections.audit = auditReminder(s.calls, runAudit(input.sessionID))
        }

        // Section 4 -- budget crossings, latched per metric so a sustained
        // overage reports once. Observe mode still latches and logs: it
        // measures what WOULD have been injected without injecting it.
        const crossed = takeCrossings(input.sessionID, s, metrics)
        if (crossed.length > 0 && MODE !== "observe") {
          sections.budget = budgetSection(metrics, crossed)
        }

        // Section 5 -- the handoff skeleton, last because it is the
        // conclusion the sections above argue for.
        //
        // Keyed on the VERDICT, not the stored level. s.level is monotone, so
        // testing it here would re-inject the whole skeleton on every tool
        // call for the rest of the session once a handoff had ever been
        // recommended. The verdict is one-shot by construction: it can only
        // reach HANDOFF_RECOMMENDED while a pause is armed, and the pause is
        // consumed at the top of this hook.
        if (verdict.state === "HANDOFF_RECOMMENDED") {
          log(`${input.sessionID} handoff recommended at ${s.calls} calls (${verdict.driver.detail})`)
          sections.handoff = handoffLines(input.sessionID)
        }

        const lines = renderPolicy(verdict, s.calls, sections)
        if (lines) {
          output.output += note(lines)
          // One toast per emission, titled by the state, so the TUI shows the
          // same severity the injected block does.
          if (rose || sections.handoff) toast(client, `Token norm: ${level} (${s.calls} calls)`)
        }
      } catch {
        /* the policy pass is advisory; never break a tool call */
      }
    },

    // Block mode is opt-in and the only path that fails a tool call. It is
    // deliberately the last resort: refusing work strands the session, so
    // cheap tools and the handoff tool stay open as the escape hatch.
    "tool.execute.before": async (input) => {
      if (MODE !== "block") return
      if (CHEAP_TOOLS.has(input.tool) || input.tool === HANDOFF_TOOL) return
      let message: string | undefined
      try {
        const { metrics } = await measure(client, input.sessionID)
        const s = state.get(input.sessionID)
        // BLOCKED is the machine's verdict, not a separate over-limit test, so
        // the gate can never refuse a call the status tool calls healthy.
        const verdict = evaluatePolicy({
          calls: s?.calls ?? 0,
          metrics,
          mode: MODE,
          pauseArmed: s?.pendingHandoff ?? false,
        })
        if (verdict.state === "BLOCKED") message = blockMessage(metrics)
      } catch {
        // An unmeasurable session is never blocked: refusing work on a number
        // we could not read would strand the session on our own bug.
        return
      }
      if (message) throw new Error(message)
    },

    // Compaction is the one moment the agent provably re-reads its own rules.
    // Adding the number matters, because "you are 180 calls deep" is a fact
    // that changes behavior and "be frugal" is not.
    "experimental.session.compacting": async (input, output) => {
      const s = state.get(input.sessionID)
      if (!s) return
      output.context.push(compactionContext(s.calls, topTools(s)))
    },
  }
}
