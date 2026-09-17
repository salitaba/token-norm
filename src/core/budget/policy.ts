// The one place that decides how alarmed this plugin is.
//
// WHY THIS EXISTS
// The thresholds grew one at a time -- announce, then audit, then the task
// boundary, then budget crossings, then handoff arming, then block mode -- and
// each arrived as its own `if` in the tool.execute.after hook with its own
// latch. Eight independent decision sites produced three contradictions that
// only show up in a live session:
//
//   1. Three of them could fire on the SAME tool call, stapling three separate
//      <system-reminder> blocks and two toasts onto one tool result. The agent
//      reads that as noise and starts skipping all of them -- the exact failure
//      the boundary reminder's own comment was written to prevent.
//   2. Two of them returned early, so a budget crossing that happened on the
//      same call as an announce was silently deferred a call.
//   3. The status tool answered from a fourth, disconnected severity ladder, so
//      `token_norm_status` could say "continue" while the hook was warning.
//
// So severity is computed ONCE, here, as a small monotone state machine, and
// every consumer -- the hook, the block gate, the status tool -- reads the same
// answer. Adding a threshold means adding an axis, not another `if`.
//
// This module is pure: no I/O, no clock, no session lookup. It takes measured
// numbers and returns a verdict, which is what makes the invariants (monotone,
// at most one block per call, no oscillation at a boundary) testable directly.

import { ANNOUNCE_AT, CONTEXT_WARN, type BudgetMode } from "../config.js"

/** Ordered least to most severe. The ordering IS the semantics: the session
 * state is the max over the axes, and it never moves backwards. */
export const POLICY_STATES = ["HEALTHY", "ATTENTION", "PRESSURE", "HANDOFF_RECOMMENDED", "BLOCKED"] as const

export type PolicyState = (typeof POLICY_STATES)[number]

export type AxisName = "calls" | "budget" | "context"

export function ordinal(state: PolicyState): number {
  return POLICY_STATES.indexOf(state)
}

export function maxState(a: PolicyState, b: PolicyState): PolicyState {
  return ordinal(a) >= ordinal(b) ? a : b
}

/** One measured quantity with a crossing threshold.
 *
 * `warnAt` is the limit itself for cost/tokens/calls -- those are hard budgets
 * the user set, so reaching one IS the event. Context is different: the window
 * is not a budget but a wall, and arriving at it mid-task is unrecoverable, so
 * it warns at a fraction (CONTEXT_WARN) and only "exceeds" at the wall. */
export interface BudgetMetric {
  key: string
  label: string
  used: number
  limit: number
  warnAt: number
  format: (n: number) => string
}

export const CONTEXT_KEY = "context"

export interface Axis {
  name: AxisName
  state: PolicyState
  /** At or past a hard limit -- what block mode refuses on. Never true for the
   * calls axis, which has no hard limit of its own. */
  exceeded: boolean
  /** Driver text for the reminder header, e.g. `context 600/1.0k (60%)`. */
  detail: string
}

export interface Axes {
  calls: Axis
  budget: Axis
  context: Axis
}

export interface PolicyVerdict {
  axes: Axes
  /** Severity from measurement alone, before the mode lift. */
  base: PolicyState
  /** What the mode makes of `base`: the state to store and report. */
  state: PolicyState
  /** The axis that produced `base`, most specific first. */
  driver: Axis
  /** Any axis is at or past a hard limit, regardless of mode. */
  exceeded: boolean
}

export interface PolicyInput {
  /** Per-session, cheap-tool-filtered call count -- the same number the
   * announce/audit/boundary thresholds have always used. Deliberately NOT the
   * session-tree rollup: this axis is about how long THIS conversation has run,
   * while MAX_TOOL_CALLS is a budget over the whole tree and stays a metric. */
  calls: number
  metrics: BudgetMetric[]
  mode: BudgetMode
  /** A pause (session idle, or every todo complete) has been observed and not
   * yet acted on. Only handoff mode consults it. */
  pauseArmed: boolean
}

function pct(m: BudgetMetric): number {
  return m.limit > 0 ? Math.round((m.used / m.limit) * 100) : 0
}

function describe(m: BudgetMetric): string {
  return `${m.key} ${m.format(m.used)}/${m.format(m.limit)} (${pct(m)}%)`
}

/** How long this session has run. Reaching the announce threshold is worth
 * saying out loud, but length alone is not pressure -- a 300-call session
 * inside its budget is expensive, not endangered -- so this axis stops at
 * ATTENTION and never escalates on its own. */
export function callsAxis(calls: number): Axis {
  return {
    name: "calls",
    state: calls >= ANNOUNCE_AT ? "ATTENTION" : "HEALTHY",
    exceeded: false,
    detail: `call count ${calls}/${ANNOUNCE_AT}`,
  }
}

/** User-set budgets over the session tree: cost, effective tokens, tool calls.
 * warnAt === limit for all three, so crossing and exceeding are the same edge;
 * the distinction still exists because block mode acts only on `exceeded`. */
export function budgetAxis(metrics: BudgetMetric[]): Axis {
  const budgets = metrics.filter((m) => m.key !== CONTEXT_KEY)
  const over = budgets.filter((m) => m.used >= m.warnAt)
  return {
    name: "budget",
    state: over.length > 0 ? "PRESSURE" : "HEALTHY",
    exceeded: budgets.some((m) => m.used >= m.limit),
    detail: over.length > 0 ? over.map(describe).join(", ") : budgets.map(describe).join(", ") || "no budget set",
  }
}

/** The model's own context window. Absent when the window cannot be resolved --
 * pressure is then simply not evaluated, never guessed from a default. */
export function contextAxis(metrics: BudgetMetric[]): Axis {
  const m = metrics.find((x) => x.key === CONTEXT_KEY)
  if (!m) {
    return { name: "context", state: "HEALTHY", exceeded: false, detail: "context window unknown" }
  }
  return {
    name: "context",
    state: m.used >= m.warnAt ? "PRESSURE" : "HEALTHY",
    exceeded: m.used >= m.limit,
    detail: `${describe(m)}, warn at ${Math.round(CONTEXT_WARN * 100)}%`,
  }
}

/** Most specific driver first: a named window beats a user budget beats a raw
 * call count, so the header blames the thing the user can act on. */
const DRIVER_ORDER: AxisName[] = ["context", "budget", "calls"]

function pickDriver(axes: Axes, base: PolicyState): Axis {
  // At HEALTHY every axis matches, and the most-specific rule would then blame
  // context -- including when the window could not even be resolved, which
  // reads as "context is the problem" on a session with no problem. Nothing is
  // driving anything yet, so attribute it to the axis that always exists.
  if (base === "HEALTHY") return axes.calls
  for (const name of DRIVER_ORDER) {
    if (axes[name].state === base) return axes[name]
  }
  return axes.calls
}

/** Measure, then let the mode decide what the measurement means.
 *
 * The lift is applied AFTER the max, never inside an axis, so the axes stay a
 * statement of fact and the mode stays a statement of policy. That separation
 * is why observe mode can be honest: the state is computed exactly as it would
 * be in warn mode and reported truthfully by token_norm_status, while the
 * renderer suppresses the budget section so nothing is injected. */
export function evaluatePolicy(input: PolicyInput): PolicyVerdict {
  const axes: Axes = {
    calls: callsAxis(input.calls),
    budget: budgetAxis(input.metrics),
    context: contextAxis(input.metrics),
  }
  const base = maxState(maxState(axes.calls.state, axes.budget.state), axes.context.state)
  const exceeded = axes.calls.exceeded || axes.budget.exceeded || axes.context.exceeded

  let state = base
  // Block is the only mode that fails a tool call, so it acts on the hard
  // limit alone -- pressure is not enough to strand a session.
  if (input.mode === "block" && exceeded) state = "BLOCKED"
  // A handoff needs BOTH pressure and a pause. Pressure alone would interrupt
  // work in flight, which is how a recommendation becomes an annoyance.
  else if (input.mode === "handoff" && input.pauseArmed && ordinal(base) >= ordinal("PRESSURE")) {
    state = "HANDOFF_RECOMMENDED"
  }

  return { axes, base, state, driver: pickDriver(axes, base), exceeded }
}

/** The header every injected block carries, naming the state and its driver so
 * the agent can see WHY without reading the sections below. */
export function policyHeader(verdict: PolicyVerdict, calls: number): string {
  return `TOKEN NORM -- ${verdict.state} (driver: ${verdict.driver.detail}; calls ${calls})`
}

/** Fixed section order, most actionable first. A task boundary can stop the
 * spend the others only measure, so it leads; the handoff skeleton is the
 * conclusion, so it closes. */
export interface PolicySections {
  boundary?: string[]
  announce?: string[]
  audit?: string[]
  budget?: string[]
  handoff?: string[]
}

const SECTION_ORDER: Array<keyof PolicySections> = ["boundary", "announce", "audit", "budget", "handoff"]

/** ONE block per tool call, or none.
 *
 * Returns undefined when no section has anything to say -- a bare header is
 * noise, and in observe mode the budget section is withheld, which can leave a
 * real state change with nothing to print. That is intended: observe mode
 * measures without injecting. */
export function renderPolicy(verdict: PolicyVerdict, calls: number, sections: PolicySections): string[] | undefined {
  const present = SECTION_ORDER.map((key) => sections[key]).filter(
    (lines): lines is string[] => Array.isArray(lines) && lines.length > 0,
  )
  if (present.length === 0) return undefined
  const lines = [policyHeader(verdict, calls)]
  for (const section of present) lines.push("", ...section)
  return lines
}
