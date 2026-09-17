// Claude Code transcript reader: measured tokens out of
// ~/.claude/projects/<slug-of-cwd>/<session-id>.jsonl
//
// WHY THIS IS WRITTEN DEFENSIVELY
// Anthropic documents the transcript as internal and version-unstable. It is
// nonetheless the only measured-token source the host offers (see the matrix in
// docs/multi-host-port.md §3), so the trade is: read it, but never let it take a
// hook process down with it. Every field is guarded, every number is checked,
// and the entry point cannot throw. A budget that reports a call count instead
// of a token count is degraded; one that throws inside a PreToolUse hook breaks
// the user's tool call, which is a far worse failure than being approximate.
//
// THE DEDUP TRAP -- measured on real transcripts, not assumed
// One assistant API response is written as one JSONL line PER CONTENT BLOCK
// (`apiBlockIndex` 0,1,2...), and every one of those lines repeats the whole
// message's `usage` object verbatim. In a 21-assistant-line sample there were 6
// distinct `message.id`s; summing lines gave 27,070 output tokens against a true
// 7,215 -- a 3.75x overcount. Deduping by message id is not an optimization, it
// is the difference between a budget that escalates on time and one that
// escalates at a quarter of the real spend.
//
// Two sibling fields are breakdowns, NOT additions, and must not be summed with
// their parents: `usage.iterations[]` itemizes retries of the same message, and
// `usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens` splits
// `cache_creation_input_tokens` by TTL.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { RawTokens } from "../core/host.js"

/** Default transcript root. The override exists for tests and for installs that
 * relocate ~/.claude; it is kept local to this module rather than added to
 * core/config.ts because only the Claude host can use it. */
export function projectsDir(): string {
  return process.env.TOKEN_NORM_CLAUDE_PROJECTS || path.join(os.homedir(), ".claude", "projects")
}

/** Claude Code names a project directory after its cwd with every character
 * outside [A-Za-z0-9] replaced by "-". Verified against the installed host:
 *
 *     /home/u/Desktop/code/token-norm  ->  -home-u-Desktop-code-token-norm
 *     /home/u/.openclaw/workspace      ->  -home-u--openclaw-workspace
 *
 * The leading "-" is the leading "/", and the doubled "-" in the second case is
 * "/" followed by "." -- both are load-bearing, which is why this is a character
 * map and not a path join. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-")
}

/** Session ids are host-supplied (they arrive on hook stdin), so they are
 * reduced to the alphabet real ids use before being joined onto a path.
 * Dropping "." as well as separators is deliberate: it makes ".." unable to
 * survive, so a malformed id cannot walk out of the projects directory. */
function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "-")
}

export function transcriptPath(opts: { sessionId: string; cwd?: string; projectsDir?: string }): string {
  const root = opts.projectsDir ?? projectsDir()
  const cwd = opts.cwd ?? process.cwd()
  return path.join(root, projectSlug(cwd), safeSessionId(opts.sessionId) + ".jsonl")
}

import { addTokens, isRecord, num, str, type TranscriptRead, type TranscriptSource, type TranscriptTurn } from "./transcript.js"

// The contract moved to ./transcript.ts so usage/codex.ts can implement the same
// shape without importing from this Claude-specific module. Re-exported because
// every existing caller imports these names from here.
export { addTokens }
export type { TranscriptRead, TranscriptSource, TranscriptTurn }

/** Maps the host's usage object onto RawTokens. Field names are pinned in
 * docs/multi-host-port.md §3 and verified against real files. */
function tokensOf(usage: Record<string, unknown>): { tokens: RawTokens; measured: boolean } {
  const input = num(usage.input_tokens)
  const output = num(usage.output_tokens)
  const write = num(usage.cache_creation_input_tokens)
  const read = num(usage.cache_read_input_tokens)
  const details = usage.output_tokens_details
  const reasoning = isRecord(details) ? num(details.thinking_tokens) : undefined

  const tokens: RawTokens = {}
  if (input !== undefined) tokens.input = input
  if (output !== undefined) tokens.output = output
  if (reasoning !== undefined) tokens.reasoning = reasoning
  if (read !== undefined || write !== undefined) {
    tokens.cache = {}
    if (read !== undefined) tokens.cache.read = read
    if (write !== undefined) tokens.cache.write = write
  }
  const measured =
    input !== undefined ||
    output !== undefined ||
    reasoning !== undefined ||
    read !== undefined ||
    write !== undefined
  return { tokens, measured }
}


/** Reads the whole file, or its last `maxBytes` if it is bigger. The cap is not
 * about speed: a multi-hundred-megabyte transcript read into a short-lived hook
 * process can fail allocation, and degrading to a recent window beats degrading
 * to nothing. The first line of a tail read is dropped by the caller because it
 * is almost certainly cut mid-line. */
function readText(file: string, maxBytes: number): { text: string; partial: boolean } {
  const size = fs.statSync(file).size
  if (size <= maxBytes) return { text: fs.readFileSync(file, "utf8"), partial: false }
  const fd = fs.openSync(file, "r")
  try {
    const buffer = Buffer.allocUnsafe(maxBytes)
    const read = fs.readSync(fd, buffer, 0, maxBytes, size - maxBytes)
    return { text: buffer.subarray(0, read).toString("utf8"), partial: true }
  } finally {
    fs.closeSync(fd)
  }
}

export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

export interface ReadOptions {
  /** Explicit file wins; otherwise the path is composed from sessionId + cwd. */
  file?: string
  sessionId?: string
  cwd?: string
  projectsDir?: string
  maxBytes?: number
}

function empty(file: string, source: TranscriptSource, reason?: string): TranscriptRead {
  return {
    source,
    path: file,
    turns: [],
    measuredTurns: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    lines: 0,
    skipped: 0,
    partial: false,
    reason,
  }
}

/** Never throws. Every failure resolves to a TranscriptRead whose `source` says
 * how much to trust it. */
export function readTranscript(options: ReadOptions): TranscriptRead {
  let file = ""
  try {
    file = options.file ?? transcriptPath({
      sessionId: options.sessionId ?? "",
      cwd: options.cwd,
      projectsDir: options.projectsDir,
    })
    if (!options.file && !options.sessionId) return empty(file, "missing", "no session id")
    if (!fs.existsSync(file)) return empty(file, "missing", "no transcript at path")

    const { text, partial } = readText(file, options.maxBytes ?? DEFAULT_MAX_BYTES)
    const lines = text.split("\n")
    if (partial) lines.shift()

    // Insertion-ordered: a Map keeps file order while collapsing repeats.
    const byKey = new Map<string, TranscriptTurn>()
    let skipped = 0
    let seen = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      seen++
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        skipped++ // truncated tail, or a line the host wrote in another format
        continue
      }
      if (!isRecord(parsed)) continue
      if (parsed.type !== "assistant") continue
      const message = isRecord(parsed.message) ? parsed.message : undefined

      const key =
        str(message?.id) ?? str(parsed.requestId) ?? str(parsed.uuid) ?? "line:" + String(i)
      const usage = message && isRecord(message.usage) ? message.usage : undefined
      const { tokens, measured } = usage ? tokensOf(usage) : { tokens: {}, measured: false }

      // Last write wins. Repeated content-block lines carry identical usage, so
      // this is a no-op for them; if a retry ever revised the numbers upward the
      // final line is the one to believe.
      const existing = byKey.get(key)
      byKey.set(key, {
        key,
        sessionId: str(parsed.sessionId) ?? str(parsed.session_id) ?? existing?.sessionId,
        requestId: str(parsed.requestId) ?? existing?.requestId,
        timestamp: str(parsed.timestamp) ?? existing?.timestamp,
        sidechain: parsed.isSidechain === true || existing?.sidechain === true,
        tokens: measured ? tokens : (existing?.tokens ?? tokens),
        measured: measured || existing?.measured === true,
      })
    }

    const turns = [...byKey.values()]
    const measuredList = turns.filter((t) => t.measured)
    let total: RawTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    for (const turn of measuredList) total = addTokens(total, turn.tokens)

    return {
      source: measuredList.length > 0 ? "measured" : "counted",
      path: file,
      turns,
      measuredTurns: measuredList.length,
      tokens: total,
      latest: measuredList.length > 0 ? measuredList[measuredList.length - 1].tokens : undefined,
      lines: seen,
      skipped,
      partial,
      reason: measuredList.length > 0 ? undefined : "no readable usage; count turns instead",
    }
  } catch (error) {
    // EACCES, EISDIR, ENOMEM, a homedir() that throws -- all the same answer.
    return empty(file, "unreadable", error instanceof Error ? error.message : String(error))
  }
}
