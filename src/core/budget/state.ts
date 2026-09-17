// Session bookkeeping for the session-budget plugin.
//
// One SessionState per session plus one UsageTracker for the whole process.
//
// The records used to live in a module-level Map, which is correct exactly as
// long as the process outlives the session. That holds for opencode, where this
// is an in-process plugin, and fails completely for Claude Code and Codex,
// whose hooks are a fresh process per tool call. So the Map became a
// SessionStore: opencode keeps the in-memory backend and the same fast path it
// always had, and the hook adapters swap in a disk backend via setStateStore.
//
// The store is a plain key/value; what makes a reload safe rather than merely
// possible is the codec below, and specifically its `merge`. See the comment
// there before changing any field's rule.

import { CHEAP_TOOLS, weightOf } from "../config.js"
import { MemoryStore, type SessionStore, type StoreCodec } from "../../runtime/store.js"
import { UsageTracker } from "../usage.js"
import { maxState, POLICY_STATES, type PolicyState } from "./policy.js"

export interface SessionState {
  calls: number
  weightedCalls: number
  announced: boolean
  lastAudit: number
  tools: Map<string, number>
  seenMessages: Set<string>
  pendingBoundary: boolean
  /** A pause was observed; handoff mode turns it into a recommendation once
   * the session is also under pressure. */
  pendingHandoff: boolean
  /** Budget metrics whose crossing has already been reported this session. */
  crossed: Set<string>
  /** Highest severity this session has ever reached.
   *
   * MONOTONE BY CONSTRUCTION: only ever assigned via max(). A session that
   * recovers below a threshold does not walk back down, because the reminder
   * for a crossing has already been injected and re-arming it would let a
   * metric hovering at 0.799/0.801 of the context window re-fire on every
   * other tool call. Severity here means "how bad has this gotten", not "how
   * bad is it this instant" -- the instantaneous read is the axis states,
   * recomputed fresh on every call.
   *
   * The invariant is a property of the whole lifetime, not of one process, so
   * it has to survive serialization too: a reload that decoded this field back
   * to HEALTHY would re-arm every reminder the session had already spent. Both
   * halves of that are enforced in the codec -- `decode` never silently
   * substitutes a default here, and `merge` folds with max(). */
  level: PolicyState
  /** Per-axis severity from the last evaluation, kept so the rendered header
   * can name the driver without recomputing. */
  axisLevels: Record<string, PolicyState>
}

// User messages are remembered only long enough to dedupe the repeated
// `message.updated` events that follow one message. A Set preserves insertion
// order, so the oldest entry is the eviction candidate; without a cap the set
// would grow for the life of a long session.
export const SEEN_MESSAGES_MAX = 200

export function emptySessionState(): SessionState {
  return {
    calls: 0,
    weightedCalls: 0,
    announced: false,
    lastAudit: 0,
    tools: new Map(),
    seenMessages: new Set(),
    pendingBoundary: false,
    pendingHandoff: false,
    crossed: new Set(),
    level: "HEALTHY",
    axisLevels: {},
  }
}

interface StoredSessionState {
  calls: number
  weightedCalls: number
  announced: boolean
  lastAudit: number
  tools: [string, number][]
  seenMessages: string[]
  pendingBoundary: boolean
  pendingHandoff: boolean
  crossed: string[]
  level: PolicyState
  axisLevels: Record<string, PolicyState>
}

function num(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback
}

function policyState(raw: unknown, fallback: PolicyState): PolicyState {
  return typeof raw === "string" && (POLICY_STATES as readonly string[]).includes(raw)
    ? (raw as PolicyState)
    : fallback
}

function stringSet(raw: unknown, cap?: number): Set<string> {
  if (!Array.isArray(raw)) return new Set()
  const values = raw.filter((v): v is string => typeof v === "string")
  // Insertion order is the eviction order, so an over-long list is trimmed from
  // the front: the newest entries are the ones still being deduped against.
  return new Set(cap !== undefined && values.length > cap ? values.slice(-cap) : values)
}

function countMap(raw: unknown): Map<string, number> {
  const out = new Map<string, number>()
  if (!Array.isArray(raw)) return out
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const [key, count] = entry as [unknown, unknown]
    if (typeof key === "string" && typeof count === "number" && Number.isFinite(count)) {
      out.set(key, count)
    }
  }
  return out
}

function axisLevels(raw: unknown): Record<string, PolicyState> {
  const out: Record<string, PolicyState> = {}
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out
  for (const [axis, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && (POLICY_STATES as readonly string[]).includes(value)) {
      out[axis] = value as PolicyState
    }
  }
  return out
}

function cappedUnion(a: Set<string>, b: Set<string>, cap: number): Set<string> {
  const merged = [...a, ...b.values()].filter((v, i, all) => all.indexOf(v) === i)
  return new Set(merged.length > cap ? merged.slice(-cap) : merged)
}

export const stateCodec: StoreCodec<SessionState> = {
  encode(value): StoredSessionState {
    return {
      calls: value.calls,
      weightedCalls: value.weightedCalls,
      announced: value.announced,
      lastAudit: value.lastAudit,
      tools: [...value.tools.entries()],
      seenMessages: [...value.seenMessages],
      pendingBoundary: value.pendingBoundary,
      pendingHandoff: value.pendingHandoff,
      crossed: [...value.crossed],
      level: value.level,
      axisLevels: { ...value.axisLevels },
    }
  },

  // Tolerant on purpose. A record written by an older release is missing
  // whichever fields that release did not have, and discarding it would zero a
  // live session's counters -- a worse outcome than defaulting one field.
  // Only input that is not a record at all is rejected.
  decode(raw): SessionState | undefined {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
    const stored = raw as Partial<StoredSessionState>
    return {
      calls: num(stored.calls, 0),
      weightedCalls: num(stored.weightedCalls, 0),
      announced: bool(stored.announced, false),
      lastAudit: num(stored.lastAudit, 0),
      tools: countMap(stored.tools),
      seenMessages: stringSet(stored.seenMessages, SEEN_MESSAGES_MAX),
      pendingBoundary: bool(stored.pendingBoundary, false),
      pendingHandoff: bool(stored.pendingHandoff, false),
      crossed: stringSet(stored.crossed),
      level: policyState(stored.level, "HEALTHY"),
      axisLevels: axisLevels(stored.axisLevels),
    }
  },

  /** Reconcile the record on disk with the one being written.
   *
   * Two hook processes can be in flight at once -- a PostToolUse for one call
   * overlapping the PreToolUse for the next -- and both read, mutate, write.
   * Last-write-wins would let the slower one restore a pre-increment count, so
   * every field states its own rule instead:
   *
   *   monotone counters (calls, weightedCalls, lastAudit, tools)
   *       max. A count never legitimately falls, so a lower value is always
   *       the stale reader, never a decrement.
   *   latches (announced)
   *       or. Set once and never cleared.
   *   accumulating sets (crossed, seenMessages)
   *       union. `crossed` is what stops a reminder re-firing: dropping an
   *       entry re-arms a threshold the session already paid for.
   *   high-water severity (level)
   *       max, the invariant documented on the field.
   *   consumable flags (pendingBoundary, pendingHandoff)
   *       take the writer's. These are armed by a pause and cleared when
   *       consumed; or-ing them would resurrect one that was just spent and
   *       emit the reminder twice.
   *   instantaneous reads (axisLevels)
   *       take the writer's. This is "how bad is it now", recomputed every
   *       call -- the freshest value is the correct one, not the largest. */
  merge(stored, next): SessionState {
    const tools = new Map(stored.tools)
    for (const [tool, count] of next.tools) tools.set(tool, Math.max(tools.get(tool) ?? 0, count))
    return {
      calls: Math.max(stored.calls, next.calls),
      weightedCalls: Math.max(stored.weightedCalls, next.weightedCalls),
      announced: stored.announced || next.announced,
      lastAudit: Math.max(stored.lastAudit, next.lastAudit),
      tools,
      seenMessages: cappedUnion(stored.seenMessages, next.seenMessages, SEEN_MESSAGES_MAX),
      pendingBoundary: next.pendingBoundary,
      pendingHandoff: next.pendingHandoff,
      crossed: new Set([...stored.crossed, ...next.crossed]),
      level: maxState(stored.level, next.level),
      axisLevels: next.axisLevels,
    }
  },
}

/** The live backend. `let` rather than `const` so a host adapter can swap in a
 * disk store at startup and every existing importer follows the ES module live
 * binding to it -- no registry, no re-plumbing of call sites. */
export let state: SessionStore<SessionState> = new MemoryStore<SessionState>()

export function setStateStore(store: SessionStore<SessionState>): void {
  state = store
}

// One accumulator for all sessions in this process. session-budget keeps its
// own s.calls for the call-count thresholds (announce/audit/boundary); this one
// owns measured cost/tokens/context from step-finish events.
export const usage = new UsageTracker()

export function track(sessionID: string, tool: string): SessionState {
  let s = state.get(sessionID)
  if (!s) {
    s = emptySessionState()
    state.set(sessionID, s)
  }
  if (!CHEAP_TOOLS.has(tool)) {
    s.calls++
    s.weightedCalls += weightOf(tool, usage.get(sessionID).mode)
  }
  s.tools.set(tool, (s.tools.get(tool) ?? 0) + 1)
  // A no-op on the in-memory backend, which is holding this exact object; on a
  // disk backend it is what makes the increment outlive the hook process.
  state.save(sessionID)
  return s
}

export function topTools(s: SessionState): string {
  return [...s.tools.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t, n]) => `${t} ${n}`)
    .join(", ")
}
