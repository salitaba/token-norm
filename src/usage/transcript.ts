// The transcript-reading contract, shared by every host that measures tokens
// from a file on disk.
//
// This lives in its own module rather than in usage/claude.ts because the Codex
// reader implements the same shape, and a Codex module importing types from a
// Claude-specific one would be backwards. usage/claude.ts re-exports these, so
// existing callers are unaffected.

import type { RawTokens } from "../core/host.js"

/** How the numbers were obtained. `counted` is the degraded mode the caller
 * falls back to call-counting on: the file was readable but yielded no usable
 * usage, so only the number of assistant turns is known. */
export type TranscriptSource = "measured" | "counted" | "missing" | "unreadable"

export interface TranscriptTurn {
  /** The dedup key actually used. Host-specific: `message.id` on Claude Code,
   * the record's line on Codex, which needs no dedup at all (see usage/codex.ts). */
  key: string
  sessionId?: string
  requestId?: string
  timestamp?: string
  /** Subagent (Task) turns. Recorded rather than filtered: attribution is the
   * caller's policy decision, not the reader's. */
  sidechain: boolean
  tokens: RawTokens
  /** False when the turn existed but carried no readable number -- the shape
   * changed under us. Such a turn still counts toward call-counting. */
  measured: boolean
}

export interface TranscriptRead {
  source: TranscriptSource
  path: string
  /** Deduped assistant turns in file order. `turns.length` IS the call count to
   * fall back on. */
  turns: TranscriptTurn[]
  measuredTurns: number
  /** Sum over measured turns. */
  tokens: RawTokens
  /** The last measured turn on its own. Cumulative `tokens` answers "what has
   * this session spent"; `latest` answers "how full is the window now", and the
   * two must not be confused -- cache_read alone is re-counted every turn. */
  latest?: RawTokens
  lines: number
  /** Lines that did not parse. A truncated tail shows up here as 1. */
  skipped: number
  /** True when the file exceeded `maxBytes` and only part of it was read. */
  partial: boolean
  reason?: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Rejects NaN, Infinity, negatives and anything non-numeric. A transcript that
 * starts reporting strings should read as "unmeasured", not as NaN poisoning
 * every downstream sum. */
export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function addTokens(a: RawTokens, b: RawTokens): RawTokens {
  const out: RawTokens = {
    input: (a.input ?? 0) + (b.input ?? 0),
    output: (a.output ?? 0) + (b.output ?? 0),
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
  }
  const read = (a.cache?.read ?? 0) + (b.cache?.read ?? 0)
  const write = (a.cache?.write ?? 0) + (b.cache?.write ?? 0)
  if (read || write || a.cache || b.cache) out.cache = { read, write }
  return out
}
