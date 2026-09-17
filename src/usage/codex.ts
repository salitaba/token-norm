// Codex rollout reader.
//
// Every line of ~/.codex/sessions/YYYY/MM/DD/rollout-<local-ts>-<id>.jsonl is
// {timestamp, type, payload}. The token numbers live in `event_msg` payloads of
// type `token_count`, and those already carry a CUMULATIVE `total_token_usage`,
// the last turn on its own, and `model_context_window`.
//
// So this file is much simpler than usage/claude.ts, and deliberately so: there
// is no per-content-block repetition to dedup and no turn accumulation to do.
// The last usable token_count record is the answer. Verified across 1237
// records in docs/multi-host-port.md §9g.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { RawTokens } from "../core/host.js"
import { isRecord, num, str, type TranscriptRead, type TranscriptSource, type TranscriptTurn } from "./transcript.js"

export function sessionsDir(): string {
  return path.join(os.homedir(), ".codex", "sessions")
}

export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

/** Enough of the head to reach `session_meta`, which is line 0. */
const HEAD_BYTES = 64 * 1024

export interface CodexReadOptions {
  file?: string
  sessionId?: string
  sessionsDir?: string
  maxBytes?: number
}

export interface CodexRead extends TranscriptRead {
  /** From `session_meta`. The hook input carries no `cwd` of its own (§9h), so
   * this is how a Codex adapter learns which project a session belongs to --
   * which is what scoping a handoff note needs. */
  cwd?: string
  /** `model_context_window`, else `session_meta.context_window`. Present in
   * every token_count record, so the context axis on this host needs no
   * TOKEN_NORM_CONTEXT_LIMIT. */
  contextWindow?: number
  /** The rollout format drifts between releases (§9g); worth reporting when a
   * read degrades. */
  cliVersion?: string
}

/** Locates a session's rollout by the id embedded in its FILENAME.
 *
 * Never by date: the directory partition and the filename use local time while
 * `session_meta.timestamp` is UTC, 3.5 hours apart on the machine this was
 * verified on, so computing YYYY/MM/DD lands in the wrong directory for part of
 * every day (§9g). */
export function rolloutPath(opts: { sessionId: string; sessionsDir?: string }): string | undefined {
  // An id reaches this from a hook payload, so it is not allowed to contain a
  // path separator or traversal.
  if (!/^[A-Za-z0-9._-]+$/.test(opts.sessionId)) return undefined
  const suffix = `-${opts.sessionId}.jsonl`
  const found: string[] = []
  const stack = [opts.sessionsDir ?? sessionsDir()]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) found.push(full)
    }
  }
  found.sort()
  return found[found.length - 1]
}

function readText(file: string, maxBytes: number): { text: string; partial: boolean } {
  const size = fs.statSync(file).size
  if (size <= maxBytes) return { text: fs.readFileSync(file, "utf8"), partial: false }
  const fd = fs.openSync(file, "r")
  try {
    // Both ends, not just the tail: the tail holds the cumulative total this
    // reader wants, the head holds the `session_meta` that says which project
    // the session belongs to. Reading only the tail would silently drop `cwd`
    // on exactly the largest sessions.
    //
    // Every slice is taken at the byte count readSync REPORTS. allocUnsafe
    // hands back a dirty buffer, so decoding the whole allocation after a
    // short read appends whatever was in that memory to the transcript.
    const headBytes = Math.min(HEAD_BYTES, maxBytes, size)
    const head = Buffer.allocUnsafe(headBytes)
    const headRead = fs.readSync(fd, head, 0, headBytes, 0)
    const tailBytes = Math.min(Math.max(0, maxBytes - headRead), size - headRead)
    let tailText = ""
    if (tailBytes > 0) {
      const tail = Buffer.allocUnsafe(tailBytes)
      const tailRead = fs.readSync(fd, tail, 0, tailBytes, size - tailBytes)
      tailText = tail.subarray(0, tailRead).toString("utf8")
    }
    // The join is a newline because the two chunks are unrelated lines; the
    // half-line at each cut is dropped by the JSON.parse guard and counted in
    // `skipped`.
    return { text: `${head.subarray(0, headRead).toString("utf8")}\n${tailText}`, partial: true }
  } finally {
    fs.closeSync(fd)
  }
}

/** Codex's TokenUsage onto RawTokens.
 *
 * THE thing to get right in this file. `cached_input_tokens` and
 * `reasoning_output_tokens` are BREAKDOWNS of `input_tokens` and
 * `output_tokens`, not addends: `total_tokens == input_tokens + output_tokens`,
 * verified 1237/1237 records (§9g). RawTokens sums every field it carries, so
 * the parts are subtracted back out here. Passing the four raw numbers straight
 * through overcounts by 1.96x on a real session. */
function tokensOf(usage: Record<string, unknown>): { tokens: RawTokens; measured: boolean } {
  const input = num(usage.input_tokens)
  const cached = num(usage.cached_input_tokens)
  const output = num(usage.output_tokens)
  const reasoning = num(usage.reasoning_output_tokens)
  // §3 documents a cache_write_input_tokens. No record read on this host
  // carried one, so it is used when present and never required.
  const write = num(usage.cache_write_input_tokens)

  const tokens: RawTokens = {}
  // The subset relation held in every record read, but a future shape change
  // must degrade to zero rather than to negative tokens, which would silently
  // cancel out real spend from other turns.
  if (input !== undefined) tokens.input = Math.max(0, input - (cached ?? 0))
  if (output !== undefined) tokens.output = Math.max(0, output - (reasoning ?? 0))
  if (reasoning !== undefined) tokens.reasoning = reasoning
  if (cached !== undefined || write !== undefined) tokens.cache = { read: cached ?? 0, write: write ?? 0 }

  return { tokens, measured: input !== undefined || output !== undefined }
}

function zero(): RawTokens {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function empty(file: string, source: TranscriptSource, reason?: string): CodexRead {
  return {
    source,
    path: file,
    turns: [],
    measuredTurns: 0,
    tokens: zero(),
    lines: 0,
    skipped: 0,
    partial: false,
    reason,
  }
}

export function readRollout(options: CodexReadOptions): CodexRead {
  const file =
    options.file ??
    (options.sessionId
      ? rolloutPath({ sessionId: options.sessionId, sessionsDir: options.sessionsDir })
      : undefined)
  if (!file) return empty("", "missing", "no rollout file found for this session")

  try {
    const { text, partial } = readText(file, options.maxBytes ?? DEFAULT_MAX_BYTES)
    const lines = text.split("\n")
    const turns: TranscriptTurn[] = []
    let seen = 0
    let skipped = 0
    let cumulative: RawTokens | undefined
    let latest: RawTokens | undefined
    let contextWindow: number | undefined
    let cwd: string | undefined
    let cliVersion: string | undefined
    let sessionId: string | undefined

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line.length === 0) continue
      seen++
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        // A tail read cuts its first line in half; so does a crash mid-write.
        skipped++
        continue
      }
      if (!isRecord(parsed)) {
        skipped++
        continue
      }
      const payload = isRecord(parsed.payload) ? parsed.payload : undefined
      if (!payload) continue

      if (parsed.type === "session_meta") {
        cwd = str(payload.cwd) ?? cwd
        cliVersion = str(payload.cli_version) ?? cliVersion
        sessionId = str(payload.id) ?? str(payload.session_id) ?? sessionId
        contextWindow = num(payload.context_window) ?? contextWindow
        continue
      }
      if (payload.type !== "token_count") continue
      const info = isRecord(payload.info) ? payload.info : undefined
      if (!info) continue
      contextWindow = num(info.model_context_window) ?? contextWindow

      const lastUsage = isRecord(info.last_token_usage) ? info.last_token_usage : undefined
      const turnRead = lastUsage ? tokensOf(lastUsage) : undefined
      turns.push({
        key: `token_count:${i}`,
        sessionId,
        timestamp: str(parsed.timestamp),
        // A subagent writes its own file, handed to the hook as
        // `agent_transcript_path` (§9h), so nothing in this file is a sidechain.
        sidechain: false,
        tokens: turnRead?.tokens ?? {},
        measured: turnRead?.measured === true,
      })
      if (turnRead?.measured) latest = turnRead.tokens

      const totalUsage = isRecord(info.total_token_usage) ? info.total_token_usage : undefined
      if (!totalUsage) continue
      const total = tokensOf(totalUsage)
      // Cumulative and monotone (§9g), so the last usable record wins. The
      // all-zero test is what skips the FIRST record, which can report a zero
      // total beside a non-zero last_token_usage.
      const nonzero = (total.tokens.input ?? 0) + (total.tokens.output ?? 0) + (total.tokens.cache?.read ?? 0) > 0
      if (total.measured && nonzero) cumulative = total.tokens
    }

    return {
      source: cumulative ? "measured" : "counted",
      path: file,
      turns,
      measuredTurns: turns.filter((t) => t.measured).length,
      tokens: cumulative ?? zero(),
      latest,
      lines: seen,
      skipped,
      partial,
      reason: cumulative ? undefined : "no readable token_count record; count turns instead",
      cwd,
      contextWindow,
      cliVersion,
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return empty(file, code === "ENOENT" ? "missing" : "unreadable", code ?? String(err))
  }
}
