// The handoff note as a file on disk, for hosts that cannot start a session.
//
// On opencode the handoff tool writes a note AND opens the new session with the
// note pre-filled as its first prompt, so the split is one tool call. No other
// host exposes that: Claude Code has no API for "start a session", and a hook
// cannot create one. So the split degrades to two steps the user drives --
// the agent writes the note, the user runs /clear -- and the fresh session's
// SessionStart hook is what closes the loop by injecting the note back.
//
// That means the note has to survive a process boundary and be found again by a
// session that knows nothing except its own cwd. Hence: a fixed path per
// project, not a timestamped one. The agent has to be able to type the path
// from a reminder without inventing a filename, and the reader has to find it
// without globbing and guessing which of several notes was meant.
//
// Scoping is by DIRECTORY, not by anything inside the file. A note names real
// paths and findings from one repo; injecting it into a session in a different
// repo would be both wrong and a small privacy leak. Deriving the project from
// the path means a note can only ever reach a session whose cwd hashes to the
// same slug -- there is no parse to get wrong, and a note with no directory of
// its own simply does not exist.

import fs from "node:fs"
import path from "node:path"

import { HANDOFF_DIR } from "./config.js"

/** A note older than this is not injected. `clear` writes and reads within
 * seconds, so this only governs `startup`: coming back to a project the next
 * morning should not silently reopen a task from last week as if it were the
 * current one. Stale is worse than absent -- absent is obvious. */
export const NOTE_TTL_MS = 24 * 60 * 60 * 1000

/** Consumed notes keep this infix rather than being deleted. The note is the
 * agent's own writing about work in progress, so destroying it at the moment it
 * is read is the one outcome the user cannot recover from; and because the name
 * is fixed, a later consume overwrites the previous one instead of growing a
 * pile. */
const CONSUMED = ".injected.md"

/** cwd -> one path segment. Every non-alphanumeric run becomes a dash, which
 * is lossy on purpose: two directories that differ only by punctuation are
 * vanishingly rare next to the cost of building a path out of raw user
 * directory names. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root"
}

export function noteDirFor(cwd: string): string {
  return path.join(HANDOFF_DIR, "notes", projectSlug(cwd))
}

/** Where the agent is told to write, and the only place the reader looks. */
export function notePathFor(cwd: string): string {
  return path.join(noteDirFor(cwd), "handoff.md")
}

export interface HandoffNote {
  path: string
  body: string
  ageMs: number
}

/** The newest injectable note for this project, or undefined. Never throws:
 * this runs inside a hook, and a session that cannot start because a note was
 * unreadable is a worse failure than a session that starts without one. */
export function readHandoffNote(cwd: string, now = Date.now(), ttlMs = NOTE_TTL_MS): HandoffNote | undefined {
  const file = notePathFor(cwd)
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return undefined
    const ageMs = now - stat.mtimeMs
    // A clock that moved backwards yields a negative age; treat it as fresh
    // rather than as expired, because the alternative silently drops a note
    // the agent just wrote.
    if (ageMs > ttlMs) return undefined
    const body = fs.readFileSync(file, "utf8").trim()
    if (body.length === 0) return undefined
    return { path: file, body, ageMs }
  } catch {
    return undefined
  }
}

/** Mark a note as delivered. Renamed, not deleted -- see CONSUMED. A failure
 * here is swallowed, but it is the one that matters most: a note that cannot be
 * marked would be injected into every future session of this project, so the
 * caller must treat a false return as "do not inject". */
export function consumeHandoffNote(file: string): boolean {
  try {
    fs.renameSync(file, file.replace(/\.md$/, "") + CONSUMED)
    return true
  } catch {
    return false
  }
}
