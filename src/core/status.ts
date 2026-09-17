// On-demand session accounting, exposed as an agent-callable tool.
//
// The enforcement path in session-budget.ts injects reminders when a threshold
// is crossed; this path answers the same question immediately ("where is this
// session?") without waiting for one. The numbers must come from the same
// accumulators enforcement uses -- usage.rollup for cost/tokens, contextNow for
// the window, budgetMetrics for limits and warn thresholds -- so a status can
// never disagree with the reminder that would have been injected.
//
// session-budget.ts owns those accumulators, so it builds the reader and
// injects it through createStatusTool: importing session-budget.ts back would
// be a cycle, and a module-global registry would let a second plugin instance
// in the same process shadow the first one's reader. With no injected reader,
// an unknown session, or a reader that throws, the result is zeros: a status
// query must never break a session.

import { maxState, type AxisName, type PolicyState } from "./budget/policy.js"

export type Recommendation = "continue" | "warn" | "handoff" | "block"

export interface StatusMetric {
  used: number
  /** null when no limit is configured -- distinct from a zero/absent limit. */
  limit: number | null
}

/** Severity reported as two distinct readings.
 *
 * `state` alone was ambiguous: it carried the session's monotone HIGH-WATER
 * mark, so a session that touched PRESSURE at call 90 and then finished its
 * expensive work still reported PRESSURE at call 120 with nothing wrong right
 * now. Callers could not tell "this is bad" from "this has been bad", and the
 * only way to find out was to read the plugin source.
 *
 * So both readings are named:
 *   current -- severity of THIS instant, recomputed from the axes every call.
 *              It can fall, e.g. when a subagent's context is no longer the
 *              driver, or when the session tree shrinks after a deletion.
 *   peak    -- the highest severity the session has ever reached. Monotone by
 *              construction; this is what `state` has always meant. */
export interface PolicyStatus {
  current: PolicyState
  peak: PolicyState
  /** The axis that produced `current`: which number to look at first. */
  driver: AxisName
}

export interface StatusSnapshot {
  session: {
    /** The context window is measured on the current session only. */
    scope: "current-session"
    context: number
    contextLimit: number | null
  }
  budget: {
    /** Budgets roll up the session tree: the root plus every descendant. */
    scope: "session-tree"
    toolCalls: number
    cost: StatusMetric
    effectiveTokens: StatusMetric
  }
  /** DEPRECATED alias of `policy.peak`, kept so existing readers of the flat
   * field keep working. New callers should read `policy`. */
  state: PolicyState
  policy: PolicyStatus
  /** Derived from `policy.peak`, not `policy.current`: a session that has
   * already crossed a threshold has already spent the money, so the advice
   * does not relax just because the last tool call was cheap. */
  recommendation: Recommendation
}

/** What the owning plugin measures; snapshotFrom turns it into the wire shape. */
export interface StatusFacts {
  toolCalls: number
  context: number
  contextLimit?: number
  cost: { used: number; limit?: number }
  effectiveTokens: { used: number; limit?: number }
  /** The instantaneous verdict from the same policy machine that drives
   * enforcement. */
  current: PolicyState
  /** The session's stored high-water mark. Defaults to `current` when the
   * session has no stored level yet (unknown or brand-new session). */
  peak?: PolicyState
  /** Defaults to the calls axis, which is the one that always exists. */
  driver?: AxisName
}

export type StatusProvider = (
  sessionID: string,
) => StatusSnapshot | undefined | Promise<StatusSnapshot | undefined>

let provider: StatusProvider | undefined

export function setStatusProvider(fn: StatusProvider | undefined): void {
  provider = fn
}

function metric(used: number, limit: number | undefined): StatusMetric {
  return { used, limit: limit ?? null }
}

/** The policy state translated into the advice the caller asked for.
 *
 * This is a MAP, not a second ladder. It used to be a function that re-derived
 * severity from (pressured, exceeded, mode) -- a fourth copy of the gating
 * rules that drifted from the ones the hook actually enforced, so the tool
 * could answer "continue" on a session that was being warned. The state now
 * arrives already decided; all that is left is naming it. */
const RECOMMENDATION: Record<PolicyState, Recommendation> = {
  HEALTHY: "continue",
  ATTENTION: "warn",
  PRESSURE: "warn",
  HANDOFF_RECOMMENDED: "handoff",
  BLOCKED: "block",
}

export function recommendationFor(state: PolicyState): Recommendation {
  return RECOMMENDATION[state]
}

export function snapshotFrom(facts: StatusFacts): StatusSnapshot {
  // peak is forced above current even if a caller passes a stale stored level:
  // the snapshot must satisfy its own invariant (peak >= current) regardless of
  // what the owning plugin hands in.
  const peak = maxState(facts.peak ?? facts.current, facts.current)
  return {
    session: {
      scope: "current-session",
      context: facts.context,
      contextLimit: facts.contextLimit ?? null,
    },
    budget: {
      scope: "session-tree",
      toolCalls: facts.toolCalls,
      cost: metric(facts.cost.used, facts.cost.limit),
      effectiveTokens: metric(facts.effectiveTokens.used, facts.effectiveTokens.limit),
    },
    state: peak,
    policy: { current: facts.current, peak, driver: facts.driver ?? "calls" },
    recommendation: recommendationFor(peak),
  }
}

export function emptyStatus(): StatusSnapshot {
  return snapshotFrom({
    toolCalls: 0,
    context: 0,
    cost: { used: 0 },
    effectiveTokens: { used: 0 },
    current: "HEALTHY",
  })
}

/** Never throws: an absent provider, unknown session, or failed read reports zeros. */
export async function readStatus(
  provider: StatusProvider | undefined,
  sessionID: string | undefined,
): Promise<StatusSnapshot> {
  if (!provider || typeof sessionID !== "string" || sessionID.length === 0) return emptyStatus()
  try {
    const snapshot = await provider(sessionID)
    return snapshot ?? emptyStatus()
  } catch {
    return emptyStatus()
  }
}

export function renderStatus(snapshot: StatusSnapshot): string {
  return JSON.stringify(snapshot, null, 2)
}
