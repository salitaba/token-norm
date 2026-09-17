// Budget measurement: turn provider events into the numbers policy.ts judges.
//
// This module measures and formats. It does NOT decide how alarmed to be --
// that is policy.ts, and keeping the split sharp is why the status tool and the
// enforcement hook can no longer disagree. Anything here that returns a
// severity would be a second ladder.

import {
  CONTEXT_LIMIT,
  CONTEXT_WARN,
  MAX_COST,
  MAX_EFFECTIVE_TOKENS,
  MAX_TOOL_CALLS,
  MODE,
  type BudgetMode,
} from "../config.js"
import type { BudgetClient } from "../host.js"
import { log } from "../log.js"
import type { Rollup } from "../usage.js"
import { fmtCount, fmtTokens, fmtUsd } from "./format.js"
import { CONTEXT_KEY, type BudgetMetric } from "./policy.js"
import { usage, type SessionState } from "./state.js"

export type { BudgetMetric } from "./policy.js"

const modelContextLimits = new Map<string, number>()

/** Model window size, cached per provider/model for the lifetime of the
 * process. Provider config changes (edited model limits, re-registered models)
 * are not picked up until opencode restarts; TOKEN_NORM_CONTEXT_LIMIT bypasses
 * the cache entirely. When neither the client lookup nor the env var yields a
 * number, context pressure is simply disabled -- never guessed. */
export async function contextLimitFor(
  client: BudgetClient | undefined,
  sessionID: string,
): Promise<number | undefined> {
  if (CONTEXT_LIMIT !== undefined) return CONTEXT_LIMIT
  const s = usage.get(sessionID)
  if (!s.providerID || !s.modelID) return undefined
  const key = `${s.providerID}/${s.modelID}`
  const cached = modelContextLimits.get(key)
  if (cached !== undefined) return cached > 0 ? cached : undefined
  try {
    const res = await client?.config?.providers?.()
    const providers = res?.data?.providers ?? res?.providers
    if (!Array.isArray(providers)) return undefined
    const model = providers.find((p) => p?.id === s.providerID)?.models?.[s.modelID]
    const limit = typeof model?.limit?.context === "number" ? model.limit.context : 0
    modelContextLimits.set(key, limit)
    return limit > 0 ? limit : undefined
  } catch {
    return undefined
  }
}

export function budgetMetrics(sessionID: string, rollup: Rollup, contextLimit: number | undefined): BudgetMetric[] {
  const metrics: BudgetMetric[] = []
  if (MAX_COST !== undefined) {
    metrics.push({ key: "cost", label: "Cost", used: rollup.costUsd, limit: MAX_COST, warnAt: MAX_COST, format: fmtUsd })
  }
  if (MAX_EFFECTIVE_TOKENS !== undefined) {
    metrics.push({
      key: "effective-tokens",
      label: "Effective tokens",
      used: rollup.effectiveTokens,
      limit: MAX_EFFECTIVE_TOKENS,
      warnAt: MAX_EFFECTIVE_TOKENS,
      format: fmtTokens,
    })
  }
  if (MAX_TOOL_CALLS !== undefined) {
    metrics.push({
      key: "tool-calls",
      label: "Weighted tool calls",
      used: rollup.weightedCalls,
      limit: MAX_TOOL_CALLS,
      warnAt: MAX_TOOL_CALLS,
      format: fmtCount,
    })
  }
  if (contextLimit !== undefined) {
    // contextNow is this session's own window. It is NOT summable across a
    // parent and its subagents, which each have separate windows.
    const used = usage.get(sessionID).contextNow
    metrics.push({
      key: CONTEXT_KEY,
      label: "Context now",
      used,
      limit: contextLimit,
      warnAt: contextLimit * CONTEXT_WARN,
      format: fmtTokens,
    })
  }
  return metrics
}

export interface Measurement {
  metrics: BudgetMetric[]
  rollup: Rollup
  contextLimit: number | undefined
}

/** One read of every number the policy needs, so a single tool call resolves
 * the context window once instead of once per consumer. */
export async function measure(client: BudgetClient | undefined, sessionID: string): Promise<Measurement> {
  const contextLimit = await contextLimitFor(client, sessionID)
  const rollup = usage.rollup(usage.rootOf(sessionID))
  return { metrics: budgetMetrics(sessionID, rollup, contextLimit), rollup, contextLimit }
}

/** Metrics that crossed for the FIRST time, latching each so a sustained
 * overage reports once instead of on every subsequent tool call. Mutates
 * s.crossed, and logs even in observe mode -- observing is the point there. */
export function takeCrossings(sessionID: string, s: SessionState, metrics: BudgetMetric[]): string[] {
  const crossed: string[] = []
  for (const m of metrics) {
    if (m.used >= m.warnAt && !s.crossed.has(m.key)) {
      s.crossed.add(m.key)
      crossed.push(m.key)
    }
  }
  if (crossed.length === 0) return crossed
  const detail = metrics
    .filter((m) => crossed.includes(m.key))
    .map((m) => `${m.key} ${m.format(m.used)}/${m.format(m.limit)}`)
    .join(", ")
  log(`${sessionID} budget crossing at ${s.calls} calls: ${detail}`)
  return crossed
}

const MODE_ADVICE: Record<BudgetMode, string> = {
  observe: `Observe mode: crossing logged, nothing injected (empirical validation).`,
  warn: `Report this to the user in your next message. If work remains, propose a split with a 3-line handoff.`,
  handoff: `Report this to the user. A handoff skeleton is appended at the next pause (idle or todos complete).`,
  block: `This limit is now enforced: non-cheap tool calls are refused until the session ends or the mode changes.`,
}

/** The budget section of the injected block: every tracked metric with its
 * number, then which ones crossed on this call. */
export function budgetSection(metrics: BudgetMetric[], crossed: string[]): string[] {
  const lines = [`TOKEN NORM -- BUDGET (estimated from provider step-finish events):`]
  for (const m of metrics) {
    const pct = m.limit > 0 ? Math.round((m.used / m.limit) * 100) : 0
    const over = m.used >= m.warnAt ? " -- OVER" : ""
    lines.push(`  ${m.label}: ${m.format(m.used)} / ${m.format(m.limit)} (${pct}%)${over}`)
  }
  lines.push(`Crossed now: ${crossed.join(", ")}.`)
  lines.push(MODE_ADVICE[MODE])
  return lines
}

/** The refusal thrown in block mode. Names every exceeded metric and both ways
 * out, because a blocked session with no escape is a broken session. */
export function blockMessage(metrics: BudgetMetric[]): string {
  const over = metrics.filter((m) => m.used >= m.limit)
  return [
    `TOKEN NORM block (mode=block): ${over.map((m) => `${m.label} ${m.format(m.used)} / ${m.format(m.limit)}`).join("; ")}.`,
    `Non-cheap tool calls are refused while over budget. In your next message:`,
    `  1. Report the overage to the user.`,
    `  2. Propose a handoff (the handoff tool stays available) or ask the user to raise the`,
    `     limits / set TOKEN_NORM_MODE=warn and restart the session.`,
  ].join("\n")
}
