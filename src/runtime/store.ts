// Session state backends: in-memory for opencode, disk-backed for hook hosts.
//
// WHY THIS EXISTS
// opencode loads this project as an in-process plugin, so a module-level Map
// outlives every tool call in a session. Claude Code and Codex invoke hooks as
// a fresh process per event: that Map is born empty and dies a millisecond
// later, taking the call count, the crossed-threshold set and the monotone
// severity with it. Counters that reset on every tool call do not count.
//
// So the store is an interface with two backends. MemoryStore is exactly
// today's Map, and opencode keeps it -- the fast path must not pay for a
// capability it does not need. DiskStore persists one JSON file per session
// under a state directory, written atomically because two hooks can run at
// once.
//
// Three rules the backends are built around:
//
//   1. NEVER THROW. A store that fails must degrade to "no prior state", not
//      break the tool call it was observing. Enforcement is advisory; losing a
//      counter costs a missed reminder, throwing costs the user their session.
//   2. NEVER WALK A COUNTER BACKWARDS. Two hook processes can read the same
//      file, mutate, and write. Last-write-wins would let the slower process
//      erase the faster one's increment, which is how a monotone severity
//      silently un-escalates. `save` folds against what is on disk instead --
//      see StoreCodec.merge.
//   3. SESSION IDS ARE UNTRUSTED as path components. They come from the host,
//      not from us; a "../" in one must not escape the state directory.

import fs from "node:fs"
import path from "node:path"

/** Translation between a live record and its JSON form, plus the rule for
 * reconciling two versions of the same record.
 *
 * `decode` returns undefined only for input it cannot make any sense of. A
 * record missing a field it did not have when it was written is normal (the
 * shape changes between releases) and must come back with that field defaulted,
 * because the alternative -- discarding the record -- resets a session's
 * counters to zero, which is the exact failure this store exists to prevent. */
export interface StoreCodec<T> {
  encode(value: T): unknown
  decode(raw: unknown): T | undefined
  /** Fold the copy already on disk into the one being written. Called only on
   * DiskStore.save, and only when a file is already there. Omit for records
   * where a plain overwrite is correct. */
  merge?(stored: T, next: T): T
}

export interface SessionStore<T> {
  get(id: string): T | undefined
  /** Stage a record for this session. On a disk backend nothing is written
   * until `save`: a write here would be a plain overwrite, and an overwrite
   * racing another process's `save` is exactly how an increment gets erased. */
  set(id: string, value: T): void
  delete(id: string): boolean
  has(id: string): boolean
  clear(): void
  readonly size: number
  keys(): string[]
  /** Persist mutations made to the record in place since it was read. A no-op
   * for MemoryStore, where the caller already holds the only copy. */
  save(id: string): void
}

/** The Map the plugin has always used, behind the store interface.
 *
 * Callers mutate the object they get back from `get`, so the Map is holding
 * live references, not copies -- `save` has nothing to do. */
export class MemoryStore<T> implements SessionStore<T> {
  private readonly entries = new Map<string, T>()

  get(id: string): T | undefined {
    return this.entries.get(id)
  }

  set(id: string, value: T): void {
    this.entries.set(id, value)
  }

  delete(id: string): boolean {
    return this.entries.delete(id)
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }

  keys(): string[] {
    return [...this.entries.keys()]
  }

  save(_id: string): void {}
}

/** Files carry the id alongside the record: a mangled filename is not
 * reversible, and `keys` must report ids the caller can pass back to `get`. */
const ENVELOPE_VERSION = 1

interface Envelope {
  v: number
  id: string
  state: unknown
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,120}$/
const UNSAFE_CHAR = /[^A-Za-z0-9._-]/g

/** A filename that is safe, stable, and collision-free for an arbitrary id.
 *
 * Session ids are host-supplied. `ses_abc123` needs no encoding, but nothing
 * guarantees the next host does not hand us "../../.bashrc" or 400 bytes of
 * unicode. Unsafe ids get their bad characters replaced AND a hash appended:
 * replacement alone maps "a/b" and "a:b" onto the same file, which would merge
 * two unrelated sessions' counters. Leading dots are neutralised so an id can
 * never produce "." or ".." itself. */
export function fileNameFor(id: string): string {
  if (SAFE_ID.test(id) && !id.startsWith(".")) return `${id}.json`
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const slug = id.replace(UNSAFE_CHAR, "_").replace(/^\.+/, "_").slice(0, 64) || "_"
  return `${slug}.${hash.toString(16).padStart(8, "0")}.json`
}

/** One JSON file per session under `dir`.
 *
 * Records read or written in this process are kept in a working set so that
 * `save` knows what to flush and repeated reads inside one hook invocation do
 * not re-parse the file. A hook process handles a single event, so the working
 * set cannot go stale in practice; a long-lived process that wants to observe
 * another writer's changes calls `refresh`. */
export class DiskStore<T> implements SessionStore<T> {
  private readonly working = new Map<string, T>()

  constructor(
    readonly dir: string,
    private readonly codec: StoreCodec<T>,
  ) {}

  private file(id: string): string {
    return path.join(this.dir, fileNameFor(id))
  }

  private read(id: string): T | undefined {
    try {
      const raw = fs.readFileSync(this.file(id), "utf8")
      const envelope = JSON.parse(raw) as Partial<Envelope>
      if (envelope === null || typeof envelope !== "object") return undefined
      return this.codec.decode(envelope.state)
    } catch {
      // Missing, unreadable, truncated mid-write, or written by a version whose
      // shape this codec rejects. All four mean the same thing to the caller.
      return undefined
    }
  }

  get(id: string): T | undefined {
    const held = this.working.get(id)
    if (held !== undefined) return held
    const loaded = this.read(id)
    if (loaded !== undefined) this.working.set(id, loaded)
    return loaded
  }

  set(id: string, value: T): void {
    this.working.set(id, value)
  }

  /** The only path to disk. Folds against whatever is already there, so a
   * process that read a stale copy cannot roll back a newer one's progress. */
  save(id: string): void {
    const value = this.working.get(id)
    if (value === undefined) return
    const stored = this.codec.merge ? this.read(id) : undefined
    this.write(id, stored === undefined ? value : this.codec.merge!(stored, value))
  }

  private write(id: string, value: T): void {
    const file = this.file(id)
    // Same directory as the target: rename is only atomic within a filesystem,
    // and /tmp is routinely a different one.
    const tmp = `${file}.${process.pid.toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const envelope: Envelope = { v: ENVELOPE_VERSION, id, state: this.codec.encode(value) }
      fs.writeFileSync(tmp, JSON.stringify(envelope), { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch {
      try {
        fs.unlinkSync(tmp)
      } catch {}
    }
  }

  /** Drop the working set so the next `get` re-reads from disk. Exists for
   * long-lived processes and for tests that simulate a second hook run. */
  refresh(): void {
    this.working.clear()
  }

  delete(id: string): boolean {
    const held = this.working.delete(id)
    try {
      fs.unlinkSync(this.file(id))
      return true
    } catch {
      return held
    }
  }

  has(id: string): boolean {
    return this.get(id) !== undefined
  }

  /** Ids, not filenames. An id that needed mangling to become a filename
   * cannot be recovered from that filename, so it is read back out of the
   * envelope rather than guessed. */
  keys(): string[] {
    const ids = new Set(this.working.keys())
    try {
      for (const file of fs.readdirSync(this.dir)) {
        if (!file.endsWith(".json")) continue
        try {
          const envelope = JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8")) as Partial<Envelope>
          if (typeof envelope?.id === "string") ids.add(envelope.id)
        } catch {}
      }
    } catch {}
    return [...ids]
  }

  get size(): number {
    return this.keys().length
  }

  clear(): void {
    this.working.clear()
    try {
      for (const file of fs.readdirSync(this.dir)) {
        if (file.endsWith(".json") || file.endsWith(".tmp")) {
          try {
            fs.unlinkSync(path.join(this.dir, file))
          } catch {}
        }
      }
    } catch {}
  }
}
