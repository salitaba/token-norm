// Turning a Codex rollout into the numbers policy.ts already judges.
//
// The same division as hosts/claude/measure.ts, and deliberately so: a hook is a
// fresh process per tool call and sees no events, so the numbers come from the
// rollout reader and then flow through the SAME budgetMetrics / evaluatePolicy
// path opencode uses. A second metric builder here would be a second severity
// ladder, which is what core/budget/policy.ts exists to eliminate.
//
// TWO NUMBERS THAT LOOK INTERCHANGEABLE AND ARE NOT
//
//   cumulative `total_token_usage` -> SESSION SPEND
//   `last_token_usage`             -> WINDOW OCCUPANCY
//
// Codex hands both over directly (§9g), so unlike Claude Code there is no
// dedup and no accumulation to get wrong. What does not change is which axis
// each one feeds: `cache_read` is the window re-read on every turn, so the
// cumulative figure on the context axis reports a healthy session as full after
// a few turns, and `latest` on the spend axis makes a 200-call session read as
// one turn's work.

import { CONTEXT_LIMIT } from "../../core/config.js"
import { fmtTokens } from "../../core/budget/format.js"
import type { BudgetMetric } from "../../core/budget/policy.js"
import { budgetMetrics, type Measurement } from "../../core/budget/evaluator.js"
import type { SessionState } from "../../core/budget/state.js"
import { usage } from "../../core/budget/state.js"
import { effectiveFresh, type Rollup, type StepTokens } from "../../core/usage.js"
import type { RawTokens } from "../../core/host.js"
import type { CodexRead } from "../../usage/codex.js"

/** RawTokens has optional cache members; StepTokens does not. Normalising here
 * keeps `effectiveFresh` the single definition of the cost weighting rather
 * than re-deriving `input + 0.1*read + 1.25*write` on this host. */
export function stepTokens(t: RawTokens | undefined): StepTokens {
  return {
    input: t?.input ?? 0,
    output: t?.output ?? 0,
    reasoning: t?.reasoning ?? 0,
    cache: { read: t?.cache?.read ?? 0, write: t?.cache?.write ?? 0 },
  }
}

/** What the window holds after a turn: the prompt the provider read (fresh
 * input + everything served from cache) plus what it wrote back. */
export function windowOccupancy(t: RawTokens | undefined): number {
  const s = stepTokens(t)
  return s.input + s.cache.read + s.cache.write + s.output + s.reasoning
}

/** The last measured turn belonging to THIS session rather than to one of its
 * subagents.
 *
 * The rollout reader marks nothing as a sidechain today (a subagent writes its
 * own file, §9h), so on current files this is `read.latest`. It is written as a
 * scan anyway because the subagent events exist and a future reader that folds
 * `agent_transcript_path` into this session's turns must not silently promote a
 * subagent's window into this session's occupancy. */
export function mainWindowTurn(read: CodexRead): RawTokens | undefined {
  for (let i = read.turns.length - 1; i >= 0; i--) {
    const turn = read.turns[i]
    if (turn.measured && !turn.sidechain) return turn.tokens
  }
  return read.latest
}

/** Cumulative spend across every measured turn, subagents included. */
export function sessionSpend(read: CodexRead): RawTokens {
  return read.tokens
}

export interface CodexMeasurement extends Measurement {
  read: CodexRead
  /** False when the rollout yielded no usable numbers, so only the call-counting
   * axis is trustworthy. The caller says so in what it injects rather than
   * presenting a zero as a measurement. */
  measured: boolean
}

/** One read of every number the policy needs for a Codex session.
 *
 * Seeds the process-global UsageTracker before building metrics, because
 * `budgetMetrics` reads `contextNow` from it. In a hook process the tracker is
 * empty and dies with the process, so this is a scratch surface, not state --
 * the durable counters are in the session store.
 *
 * THE CONTEXT LIMIT COMES FROM THE FILE. §9e: Codex is the one host better off
 * than Claude Code here, because `model_context_window` is written into every
 * `token_count` record, so TOKEN_NORM_CONTEXT_LIMIT is an override rather than
 * a requirement. The file's value wins because it is the real one; the env var
 * is the fallback for a rollout that predates the field.
 *
 * The cost axis is dropped rather than reported as zero: `TokenUsage` records
 * tokens and no prices, so there is no cost to measure on this host. A metric
 * that always reads "$0.00 / $5.00 (0%)" looks measured and is not, and the one
 * thing worse than a missing axis is a fabricated one. */
export function measureSession(sessionId: string, read: CodexRead, s: SessionState): CodexMeasurement {
  const spend = sessionSpend(read)
  const occupancy = windowOccupancy(mainWindowTurn(read))
  const measured = read.source === "measured"

  const tracked = usage.get(sessionId)
  tracked.contextNow = occupancy
  tracked.contextPeak = Math.max(tracked.contextPeak, occupancy)
  tracked.effectiveTokens = effectiveFresh(stepTokens(spend))
  tracked.stepCount = read.measuredTurns
  // The store's counters, not the rollout's turn count: `calls` is budgeted
  // TOOL calls (cheap tools excluded, weighted by tool), and a token_count
  // record is not a tool call. They are different units.
  tracked.calls = s.calls
  tracked.weightedCalls = s.weightedCalls

  const rollup: Rollup = {
    costUsd: 0,
    effectiveTokens: tracked.effectiveTokens,
    stepCount: tracked.stepCount,
    calls: s.calls,
    weightedCalls: s.weightedCalls,
    sessions: 1,
  }

  const fromFile = read.contextWindow !== undefined && read.contextWindow > 0
  const contextLimit = fromFile ? (read.contextWindow as number) : CONTEXT_LIMIT
  const metrics = budgetMetrics(sessionId, rollup, contextLimit).filter((m) => m.key !== "cost")

  return { metrics, rollup, contextLimit, read, measured }
}

/** The audit checkpoint's payload on this host.
 *
 * `runAudit` shells out to usage-audit.py, which reads opencode's sqlite db --
 * on a Codex session it can only report that it found nothing, and pointing the
 * agent at another host's database at a checkpoint is worse than silence. The
 * rollout has the same two numbers the checkpoint asks the agent to report, so
 * they are computed here, in the audit script's own vocabulary so the
 * instruction ("report the effective-token number and the cache multiplier")
 * means the same thing on both hosts.
 *
 * Only numbers leave this function. A rollout is a full transcript of real work
 * (§9g), so no payload text is ever included. */
export function transcriptAudit(read: CodexRead): string {
  if (read.source !== "measured") {
    return [
      `(no measured usage: rollout ${read.source}${read.reason ? ` -- ${read.reason}` : ""})`,
      `Tool calls are still counted. Treat the token figures as unknown, not as zero.`,
    ].join("\n")
  }
  const t = stepTokens(read.tokens)
  const eff = effectiveFresh(t)
  const window = windowOccupancy(mainWindowTurn(read))
  // Mirror of usage-audit.py:390 -- cache read over fresh traffic. The ratio is
  // the bloat driver: it says how many times the session re-read itself.
  const ratio = t.cache.read / Math.max(1, t.input + t.output)
  return [
    `totals  : input ${fmtTokens(t.input)}  output ${fmtTokens(t.output)}  ` +
      `cache_read ${fmtTokens(t.cache.read)}  cache_write ${fmtTokens(t.cache.write)}`,
    `effective fresh tokens: ${fmtTokens(eff)}   (cost-weighted input: input + 0.1*cache_read + 1.25*cache_write)`,
    `cache   : ${ratio.toFixed(0)}x cache read / (input+output) -- bloat driver`,
    `context : ${fmtTokens(window)} in the window now (last non-subagent turn of ${read.measuredTurns} measured)`,
    read.partial ? `(rollout over size cap: tail only, totals are a floor)` : "",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

export type { BudgetMetric }
