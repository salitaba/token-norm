// Measured usage: the counting half of the budget plugin.
//
// session-budget.ts counts tool calls because that is the only signal a plugin
// used to have. OpenCode does emit the real numbers -- every assistant step
// publishes a `step-finish` part carrying cost and the full token breakdown --
// but nothing was reading them, so the norm estimated spend from tool-call
// counts with a formula that lived only in scripts/usage-audit.py.
//
// This module is the single accumulator for those events. One rule it enforces
// on the caller: `step-finish` is the ONLY token/cost source. AssistantMessage
// carries the same fields and summing both would double every dollar -- the
// bug this module exists to prevent is worth more than the fields it reads.
//
// Attribution (bytes per tool, repeated reads) is estimated from tool args and
// output sizes, never presented as provider-measured tokens: bytes are not
// tokens and chunking means neither one converts linearly into the other.

import { weightOf } from "./config.js"
import type { NormEvent, RawTokens, StepPart, ToolArgs } from "./host.js"

export interface StepTokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface StepUsage {
  partID: string
  cost: number
  effective: number
  tokens: StepTokens
  /** Prompt + output for this step, i.e. what the window holds right after it. */
  contextAfter: number
  at: number
  mode?: string
}

export interface Rollup {
  costUsd: number
  effectiveTokens: number
  stepCount: number
  calls: number
  weightedCalls: number
  sessions: number
}

export interface SessionUsage {
  sessionID: string
  parentID?: string
  childIDs: Set<string>
  costUsd: number
  effectiveTokens: number
  stepCount: number
  /** Budgeted tool calls, cheap tools excluded by the caller. */
  calls: number
  /** `calls` weighted by tool and latest assistant mode. */
  weightedCalls: number
  mode?: string
  messageModes: Map<string, string>
  contextNow: number
  contextPeak: number
  providerID?: string
  modelID?: string
  history: StepUsage[]
  /** Positive context-window growth per step; cleared by compaction. */
  deltas: number[]
  seenParts: Set<string>
  bytesByTool: Map<string, number>
  readCounts: Map<string, number>
  imageReads: number
  editedFiles: Map<string, number>
  lastTool?: string
  /** Counters folded in from deleted descendants. `session.deleted` drops the
   * entry (no tombstone per deleted session) and accumulates its totals here,
   * so rollups keep their dollars with bounded memory. */
  folded?: Rollup
}

// The event shape lives in host.ts with the rest of the host boundary; it is
// re-exported here because this module has always been its import site.
export type { NormEvent } from "./host.js"

export interface Bloat {
  medianDelta: number
  lastDelta: number
  /** Last step grew the window more than 2x the session's median growth. */
  flagged: boolean
}

export interface Attribution {
  topTools: Array<{ tool: string; bytes: number }>
  repeated: Array<{ file: string; count: number }>
  images: number
}

const HISTORY_MAX = 100
const SEEN_PARTS_MAX = 500
const EDITED_MAX = 100
const RECENT_EDITS_MAX = 20
const MESSAGE_MODES_MAX = 200
// Deleted ids are remembered exactly for a bounded window; the cap keeps that
// suppression window from becoming a second ledger.
const DELETED_MAX = 500
// Eviction must not un-suppress an id whose spend was already folded into an
// ancestor: a late step-finish would resurrect it and count the same dollars
// twice. These fixed-size filters record deleted ids with no false negatives,
// so eviction only costs precision: a false positive can swallow events for an
// id whose `session.created` this process never saw (a resumed session), never
// double-count. Undercounting is the failure direction the ledger already
// prefers across restarts.
//
// A single process-lifetime filter let false positives grow with every
// deletion. Two rotating epochs bound that instead: each holds at most
// TOMBSTONE_EPOCH_DELETIONS ids, the pair covers the most recent
// 2 x TOMBSTONE_EPOCH_DELETIONS deletions, and the combined false-positive
// rate stays under ~0.4% worst case. Late zombie events arrive within a turn,
// so the two-epoch window is ample.
const TOMBSTONE_FILTER_BITS = 1 << 15
const TOMBSTONE_FILTER_HASHES = 4
const TOMBSTONE_EPOCH_DELETIONS = 2000

function hash32(value: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/** Fixed-memory Bloom bitset. */
class BloomBits {
  private readonly bits: Uint8Array

  constructor(private readonly bitCount: number) {
    this.bits = new Uint8Array(bitCount / 8)
  }

  add(id: string): void {
    for (const bit of this.indexes(id)) this.bits[bit >> 3] |= 1 << (bit & 7)
  }

  maybe(id: string): boolean {
    for (const bit of this.indexes(id)) {
      if ((this.bits[bit >> 3] & (1 << (bit & 7))) === 0) return false
    }
    return true
  }

  private indexes(id: string): number[] {
    const h1 = hash32(id, 0x811c9dc5)
    const h2 = hash32(id, 0x9e3779b9) | 1
    const out: number[] = []
    for (let i = 0; i < TOMBSTONE_FILTER_HASHES; i++) out.push(((h1 + Math.imul(i, h2)) >>> 0) % this.bitCount)
    return out
  }
}

/** Deleted-id tombstones over two rotating epochs: an id stays suppressible
 * while it is in the current or the previous epoch's bitset. Rotation drops
 * the oldest generation so false positives stop compounding with deletions. */
class TombstoneEpochs {
  private current = new BloomBits(TOMBSTONE_FILTER_BITS)
  private previous = new BloomBits(TOMBSTONE_FILTER_BITS)
  private inserts = 0

  add(id: string): void {
    this.current.add(id)
    if (++this.inserts >= TOMBSTONE_EPOCH_DELETIONS) this.rotate()
  }

  maybe(id: string): boolean {
    return this.current.maybe(id) || this.previous.maybe(id)
  }

  private rotate(): void {
    this.previous = this.current
    this.current = new BloomBits(TOMBSTONE_FILTER_BITS)
    this.inserts = 0
  }
}

// Tool ids that write to disk. `file.edited` carries no sessionID (verified
// against the installed runtime schema: `{ file: String }`), so per-session
// edit attribution has to come from the tool args; the event only feeds a
// directory-level fallback.
const MUTATING_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"])
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico|pdf)$/i

/** Mirror of usage-audit.py:61. Output tokens are excluded on purpose: this
 * is cost-weighted *input*, a normalized proxy for what the provider charged. */
export function effectiveFresh(tokens: Partial<StepTokens> | undefined): number {
  const input = tokens?.input ?? 0
  const cache = tokens?.cache ?? ({} as StepTokens["cache"])
  return input + 0.1 * (cache.read ?? 0) + 1.25 * (cache.write ?? 0)
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function addCapped(set: Set<string>, value: string, max: number): void {
  set.add(value)
  if (set.size > max) {
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }
}

function pushCapped<T>(list: T[], value: T, max: number): void {
  list.push(value)
  if (list.length > max) list.splice(0, list.length - max)
}

function setCapped<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.set(key, value)
  if (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
}

function normalizeTokens(tokens: RawTokens | undefined): StepTokens {
  return {
    input: tokens?.input ?? 0,
    output: tokens?.output ?? 0,
    reasoning: tokens?.reasoning ?? 0,
    cache: { read: tokens?.cache?.read ?? 0, write: tokens?.cache?.write ?? 0 },
  }
}

function empty(sessionID: string): SessionUsage {
  return {
    sessionID,
    childIDs: new Set(),
    costUsd: 0,
    effectiveTokens: 0,
    stepCount: 0,
    calls: 0,
    weightedCalls: 0,
    messageModes: new Map(),
    contextNow: 0,
    contextPeak: 0,
    history: [],
    deltas: [],
    seenParts: new Set(),
    bytesByTool: new Map(),
    readCounts: new Map(),
    imageReads: 0,
    editedFiles: new Map(),
  }
}

/** Add a deleted session's own and already-folded counters into `target`. */
function fold(target: Rollup | undefined, s: SessionUsage): Rollup {
  const out: Rollup = {
    costUsd: s.costUsd,
    effectiveTokens: s.effectiveTokens,
    stepCount: s.stepCount,
    calls: s.calls,
    weightedCalls: s.weightedCalls,
    sessions: 1,
  }
  for (const part of [s.folded, target]) {
    if (!part) continue
    out.costUsd += part.costUsd
    out.effectiveTokens += part.effectiveTokens
    out.stepCount += part.stepCount
    out.calls += part.calls
    out.weightedCalls += part.weightedCalls
    out.sessions += part.sessions
  }
  return out
}

export function bloat(s: SessionUsage, factor = 2): Bloat {
  const lastDelta = s.deltas.length > 0 ? s.deltas[s.deltas.length - 1] : 0
  const medianDelta = median(s.deltas)
  return { medianDelta, lastDelta, flagged: medianDelta > 0 && lastDelta > factor * medianDelta }
}

export function attribution(s: SessionUsage): Attribution {
  const topTools = [...s.bytesByTool.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([tool, bytes]) => ({ tool, bytes }))
  const repeated = [...s.readCounts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([file, count]) => ({ file, count }))
  return { topTools, repeated, images: s.imageReads }
}

export class UsageTracker {
  private sessions = new Map<string, SessionUsage>()
  /** Recently deleted ids; exact fast-path suppression of zombie events. */
  private deleted = new Set<string>()
  /** Rotating fixed-memory record of deleted ids, including evicted ones. */
  private tombstones = new TombstoneEpochs()
  private recentEdits: string[] = []

  /** True when an id is known deleted and has no live entry, so events for it
   * are stale. The live check lets an id restarted by `session.created`
   * through even though the filter still remembers it. */
  private suppressed(sessionID: string): boolean {
    if (this.sessions.has(sessionID)) return false
    return this.deleted.has(sessionID) || this.tombstones.maybe(sessionID)
  }

  get(sessionID: string): SessionUsage {
    let s = this.sessions.get(sessionID)
    if (!s) {
      s = empty(sessionID)
      this.sessions.set(sessionID, s)
    }
    return s
  }

  has(sessionID: string): boolean {
    return this.sessions.has(sessionID)
  }

  /** Tool bytes are chars-of-output, not tokens. The caller labels them estimated. */
  noteToolCall(
    sessionID: string,
    tool: string,
    args: ToolArgs | undefined,
    output: { output?: string } | undefined,
    budgeted: boolean,
  ): void {
    // A deleted session is gone from the ledger: late tool events must not
    // re-create it or move the totals already folded into its parent.
    if (this.suppressed(sessionID)) return
    const s = this.get(sessionID)
    s.lastTool = tool
    if (budgeted) {
      s.calls++
      s.weightedCalls += weightOf(tool, s.mode)
    }
    const bytes = typeof output?.output === "string" ? Buffer.byteLength(output.output) : 0
    if (bytes > 0) s.bytesByTool.set(tool, (s.bytesByTool.get(tool) ?? 0) + bytes)

    const file = typeof args?.filePath === "string" ? args.filePath : undefined
    if (tool === "read" && file) {
      s.readCounts.set(file, (s.readCounts.get(file) ?? 0) + 1)
      if (IMAGE_EXT.test(file)) s.imageReads++
    }
    if (MUTATING_TOOLS.has(tool) && file) {
      s.editedFiles.set(file, (s.editedFiles.get(file) ?? 0) + 1)
    }
  }

  noteFileEdited(file: string): void {
    this.recentEdits = [file, ...this.recentEdits.filter((f) => f !== file)].slice(0, RECENT_EDITS_MAX)
  }

  recentEditedFiles(): string[] {
    return [...this.recentEdits]
  }

  /** Session-scoped edited files first, directory-level `file.edited` fallback. */
  editedFiles(sessionID: string): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const id of this.descendants(sessionID)) {
      const s = this.sessions.get(id)
      if (!s) continue
      for (const file of [...s.editedFiles.keys()].reverse()) {
        if (seen.has(file)) continue
        seen.add(file)
        out.push(file)
      }
    }
    if (out.length === 0) {
      for (const file of this.recentEdits) {
        if (seen.has(file)) continue
        seen.add(file)
        out.push(file)
      }
    }
    return out.slice(0, EDITED_MAX)
  }

  handleEvent(event: NormEvent | undefined): void {
    const type = event?.type
    const props = event?.properties
    if (type === "message.part.updated") {
      const part = props?.part
      if (part?.type === "step-finish") this.applyStep(part)
      return
    }
    if (type === "message.updated") {
      const info = props?.info
      if (info?.role === "assistant" && typeof info.sessionID === "string") {
        if (this.suppressed(info.sessionID)) return
        const s = this.get(info.sessionID)
        if (typeof info.providerID === "string") s.providerID = info.providerID
        if (typeof info.modelID === "string") s.modelID = info.modelID
        if (typeof info.mode === "string") {
          s.mode = info.mode
          if (typeof info.id === "string") setCapped(s.messageModes, info.id, info.mode, MESSAGE_MODES_MAX)
        }
      }
      return
    }
    if (type === "session.created" || type === "session.updated") {
      const info = props?.info
      if (!info?.id) return
      // A late `session.updated` for a deleted id is a stale event; letting it
      // re-parent a fresh entry would move money between rollups. A real
      // `session.created` starts a fresh entry: past totals stay folded into
      // the tree, never un-spent.
      if (type === "session.created") this.deleted.delete(info.id)
      else if (this.suppressed(info.id)) return
      this.setParent(this.get(info.id), info.parentID)
      return
    }
    if (type === "session.compacted") {
      const s = typeof props?.sessionID === "string" ? this.sessions.get(props.sessionID) : undefined
      if (s) {
        s.contextNow = 0
        s.deltas = []
      }
      return
    }
    if (type === "session.deleted") {
      const id = props?.info?.id ?? props?.sessionID
      if (typeof id === "string") this.remove(id)
      return
    }
    if (type === "file.edited") {
      if (typeof props?.file === "string") this.noteFileEdited(props.file)
    }
  }

  private applyStep(part: StepPart): void {
    const sessionID = part?.sessionID
    const partID = part?.id
    if (typeof sessionID !== "string" || typeof partID !== "string") return
    // A late step for a deleted session is a duplicate or a zombie, never new
    // spend -- the totals were already folded into the parent.
    if (this.suppressed(sessionID)) return
    const s = this.get(sessionID)
    // step-finish parts are published once, but dedupe by id is cheap and makes
    // a double delivery cost nothing instead of doubling the budget.
    if (s.seenParts.has(partID)) return
    addCapped(s.seenParts, partID, SEEN_PARTS_MAX)

    const tokens = normalizeTokens(part.tokens)
    const contextAfter = tokens.input + tokens.cache.read + tokens.cache.write + tokens.output
    const mode = (part.messageID !== undefined ? s.messageModes.get(part.messageID) : undefined) ?? s.mode
    if (s.contextNow > 0 && contextAfter > s.contextNow) {
      pushCapped(s.deltas, contextAfter - s.contextNow, HISTORY_MAX)
    }
    s.costUsd += typeof part.cost === "number" ? part.cost : 0
    s.effectiveTokens += effectiveFresh(tokens)
    s.stepCount++
    s.contextNow = contextAfter
    if (contextAfter > s.contextPeak) s.contextPeak = contextAfter
    pushCapped(
      s.history,
      { partID, cost: part.cost ?? 0, effective: effectiveFresh(tokens), tokens, contextAfter, at: Date.now(), mode },
      HISTORY_MAX,
    )
  }

  private setParent(s: SessionUsage, parentID: string | undefined): void {
    // A stale update cannot attach a live entry under a deleted id; an id
    // restarted by `session.created` is live and stays attachable.
    if (parentID === s.parentID || (parentID !== undefined && this.suppressed(parentID))) return
    if (s.parentID) this.sessions.get(s.parentID)?.childIDs.delete(s.sessionID)
    s.parentID = parentID
    if (parentID) this.get(parentID).childIDs.add(s.sessionID)
  }

  private remove(sessionID: string): void {
    const s = this.sessions.get(sessionID)
    if (!s) return
    // Aggregate, don't tombstone: the deleted session's totals fold into the
    // parent (money was spent; un-spending on delete lies), its live children
    // reparent to the grandparent so they stay in the root rollup, and the
    // entry is dropped. A long-lived server therefore keeps no ledger entry
    // per deleted session; the id is retained in a bounded exact window plus
    // rotating fixed-memory epochs, so late zombie events stay suppressed (see
    // `deleted` and `tombstones`).
    const parentID = s.parentID
    const parent = parentID ? this.sessions.get(parentID) : undefined
    if (parent) parent.folded = fold(parent.folded, s)
    for (const childID of s.childIDs) {
      const child = this.sessions.get(childID)
      if (!child) continue
      child.parentID = parentID
      if (parent) parent.childIDs.add(childID)
    }
    parent?.childIDs.delete(sessionID)
    this.sessions.delete(sessionID)
    addCapped(this.deleted, sessionID, DELETED_MAX)
    this.tombstones.add(sessionID)
  }

  rootOf(sessionID: string): string {
    let current = sessionID
    const seen = new Set<string>([current])
    let parent = this.sessions.get(current)?.parentID
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      current = parent
      parent = this.sessions.get(current)?.parentID
    }
    return current
  }

  private descendants(sessionID: string): string[] {
    const out: string[] = []
    const visited = new Set<string>()
    const queue = [sessionID]
    while (queue.length > 0) {
      const id = queue.shift()!
      if (visited.has(id)) continue
      visited.add(id)
      out.push(id)
      const s = this.sessions.get(id)
      if (s) queue.push(...s.childIDs)
    }
    return out
  }

  /** Cost/tokens/calls sum across the subtree. `contextNow` deliberately does
   * not: every session has its own window, so summing them would report a
   * window that does not exist. */
  rollup(sessionID: string): Rollup {
    let costUsd = 0
    let effectiveTokens = 0
    let stepCount = 0
    let calls = 0
    let weightedCalls = 0
    const ids = this.descendants(sessionID)
    let sessions = 0
    for (const id of ids) {
      const s = this.sessions.get(id)
      if (!s) continue
      const f = s.folded
      costUsd += s.costUsd + (f?.costUsd ?? 0)
      effectiveTokens += s.effectiveTokens + (f?.effectiveTokens ?? 0)
      stepCount += s.stepCount + (f?.stepCount ?? 0)
      calls += s.calls + (f?.calls ?? 0)
      weightedCalls += s.weightedCalls + (f?.weightedCalls ?? 0)
      sessions += 1 + (f?.sessions ?? 0)
    }
    return { costUsd, effectiveTokens, stepCount, calls, weightedCalls, sessions }
  }
}
