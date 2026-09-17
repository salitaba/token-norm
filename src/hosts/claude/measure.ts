// Turning a Claude Code transcript into the numbers policy.ts already judges.
//
// opencode feeds the UsageTracker from live `step-finish` events. A hook is a
// fresh process per tool call and sees no events at all, so the numbers come
// from the transcript reader instead -- and then flow through the SAME
// budgetMetrics / evaluatePolicy path opencode uses. That sameness is the
// point: a second metric builder here would be a second severity ladder, which
// is exactly what core/budget/policy.ts was written to eliminate.
//
// TWO NUMBERS THAT LOOK INTERCHANGEABLE AND ARE NOT
//
// `readTranscript` returns cumulative `tokens` and a per-turn `latest`, and
// they answer different questions:
//
//   cumulative  -> SESSION SPEND. What the provider was asked to process over
//                  the whole session. This is the effective-token axis.
//   latest      -> WINDOW OCCUPANCY. How full the context is right now.
//
// `cache_read_input_tokens` is the whole window re-read on every single turn,
// so summing it counts the same tokens once per turn. Feed the cumulative
// figure to the context axis and a healthy session reads as full after about
// three turns -- a permanent false alarm, which trains the agent to ignore
// every reminder this plugin emits. Feed `latest` to the spend axis and a
// 200-call session reads as one turn's worth of work.
//
// SUBAGENTS: counted in spend, excluded from occupancy. A Task turn is real
// money, so it belongs in the cumulative total; but it runs in its OWN window,
// so if the last measured turn happens to be a subagent's, its occupancy is not
// this session's. The reader flags `sidechain` and leaves the policy to us
// (docs/multi-host-port.md 8c); this is that policy.

import { CONTEXT_LIMIT } from "../../core/config.js"
import { fmtTokens } from "../../core/budget/format.js"
import type { BudgetMetric } from "../../core/budget/policy.js"
import { budgetMetrics, type Measurement } from "../../core/budget/evaluator.js"
import type { SessionState } from "../../core/budget/state.js"
import { usage } from "../../core/budget/state.js"
import { effectiveFresh, type Rollup, type StepTokens } from "../../core/usage.js"
import type { RawTokens } from "../../core/host.js"
import type { TranscriptRead } from "../../usage/claude.js"

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
 * subagents. Falls back to `read.latest` only when every measured turn is a
 * sidechain, where some number beats none. */
export function mainWindowTurn(read: TranscriptRead): RawTokens | undefined {
  for (let i = read.turns.length - 1; i >= 0; i--) {
    const turn = read.turns[i]
    if (turn.measured && !turn.sidechain) return turn.tokens
  }
  return read.latest
}

/** Cumulative spend across every measured turn, subagents included. */
export function sessionSpend(read: TranscriptRead): RawTokens {
  return read.tokens
}

export interface ClaudeMeasurement extends Measurement {
  read: TranscriptRead
  /** False when the transcript yielded no usable numbers, so only the
   * call-counting axis is trustworthy. The caller says so in what it injects
   * rather than presenting a zero as a measurement. */
  measured: boolean
}

/** One read of every number the policy needs for a Claude Code session.
 *
 * Seeds the process-global UsageTracker before building metrics, because
 * `budgetMetrics` reads `contextNow` from it. In a hook process the tracker is
 * empty and dies with the process, so this is a scratch surface, not state --
 * the durable counters are in the session store.
 *
 * The cost axis is dropped rather than reported as zero: the transcript records
 * tokens and no prices, so there is no cost to measure on this host. A metric
 * that always reads "$0.00 / $5.00 (0%)" looks measured and is not, and the one
 * thing worse than a missing axis is a fabricated one. */
export function measureSession(sessionId: string, read: TranscriptRead, s: SessionState): ClaudeMeasurement {
  const spend = sessionSpend(read)
  const occupancy = windowOccupancy(mainWindowTurn(read))
  const measured = read.source === "measured"

  const tracked = usage.get(sessionId)
  tracked.contextNow = occupancy
  tracked.contextPeak = Math.max(tracked.contextPeak, occupancy)
  tracked.effectiveTokens = effectiveFresh(stepTokens(spend))
  tracked.stepCount = read.measuredTurns
  // The store's counters, not the transcript's turn count: `calls` is budgeted
  // TOOL calls (cheap tools excluded, weighted by tool), and a transcript turn
  // is neither. They are different units and the thresholds are tuned to ours.
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

  const contextLimit = CONTEXT_LIMIT
  const metrics = budgetMetrics(sessionId, rollup, contextLimit).filter((m) => m.key !== "cost")

  return { metrics, rollup, contextLimit, read, measured }
}

/** The audit checkpoint's payload on this host.
 *
 * `runAudit` shells out to usage-audit.py, which reads opencode's sqlite db --
 * on a Claude session it can only report that it found nothing, and pointing
 * the agent at another host's database at a checkpoint is worse than silence.
 * The transcript has the same two numbers the checkpoint asks the agent to
 * report, so they are computed here, in the audit script's own vocabulary so
 * the instruction ("report the effective-token number and the cache
 * multiplier") means the same thing on both hosts. */
export function transcriptAudit(read: TranscriptRead): string {
  if (read.source !== "measured") {
    return [
      `(no measured usage: transcript ${read.source}${read.reason ? ` -- ${read.reason}` : ""})`,
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
    read.partial ? `(transcript over size cap: tail only, totals are a floor)` : "",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

export type { BudgetMetric }
