import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { RawTokens } from "../src/core/host.js"
import { readRollout, rolloutPath } from "../src/usage/codex.js"

let root: string

/** What a rollout line looks like on disk: {timestamp, type, payload}. */
function line(type: string, payload: unknown, timestamp = "2026-09-17T09:00:00.000Z"): string {
  return JSON.stringify({ timestamp, type, payload })
}

function usage(input: number, cached: number, output: number, reasoning: number, total: number) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total,
  }
}

function tokenCount(total: unknown, last: unknown, window = 272_000): string {
  return line("event_msg", {
    type: "token_count",
    info: { total_token_usage: total, last_token_usage: last, model_context_window: window },
  })
}

function meta(cwd: string): string {
  return line("session_meta", { id: "0199a1b2-c3d4-7000-8000-000000000001", cwd, cli_version: "0.146.0" })
}

function write(name: string, lines: string[]): string {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${lines.join("\n")}\n`)
  return file
}

/** Everything RawTokens carries, added the way the budget adds it. */
function sum(t: RawTokens): number {
  return (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "token-norm-codex-"))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("readRollout token mapping", () => {
  // The real numbers off this machine's largest session (docs §9g). The two
  // subset fields make the naive four-field sum 27,572,797 -- 1.96x the truth.
  const REAL = usage(14_034_557, 13_468_672, 45_459, 24_109, 14_080_016)

  it("maps a real record so RawTokens sums to total_tokens, not to 1.96x of it", () => {
    const file = write("sum.jsonl", [tokenCount(REAL, REAL)])
    const read = readRollout({ file })
    expect(read.source).toBe("measured")
    // THE regression guard for this file. cached_input_tokens is PART of
    // input_tokens and reasoning_output_tokens is PART of output_tokens, so
    // passing all four through would double-count both.
    expect(sum(read.tokens)).toBe(14_080_016)
    expect(sum(read.tokens)).not.toBe(27_572_797)
    expect(read.tokens.cache?.read).toBe(13_468_672)
    expect(read.tokens.input).toBe(14_034_557 - 13_468_672)
    expect(read.tokens.output).toBe(45_459 - 24_109)
    expect(read.tokens.reasoning).toBe(24_109)
  })

  it("takes the LAST cumulative record, and skips a first one reporting zero", () => {
    // Observed on real sessions: record 0 carries an all-zero total beside a
    // non-zero last_token_usage. Taking the first record reports no spend for
    // a session that has already spent.
    const file = write("cumulative.jsonl", [
      tokenCount(usage(0, 0, 0, 0, 0), usage(1_000, 0, 100, 0, 1_100)),
      tokenCount(usage(1_000, 0, 100, 0, 1_100), usage(1_000, 0, 100, 0, 1_100)),
      tokenCount(usage(5_000, 2_000, 300, 100, 5_300), usage(4_000, 2_000, 200, 100, 4_200)),
    ])
    const read = readRollout({ file })
    expect(sum(read.tokens)).toBe(5_300)
    // `latest` is the last turn on its own, which the context axis needs.
    expect(sum(read.latest ?? {})).toBe(4_200)
    expect(read.turns).toHaveLength(3)
    expect(read.measuredTurns).toBe(3)
  })

  it("clamps rather than going negative if the subset relation ever breaks", () => {
    const file = write("clamp.jsonl", [tokenCount(usage(100, 500, 10, 900, 110), undefined)])
    const read = readRollout({ file })
    expect(read.tokens.input).toBe(0)
    expect(read.tokens.output).toBe(0)
    // Negative tokens would silently cancel real spend from other turns.
    expect(sum(read.tokens)).toBeGreaterThanOrEqual(0)
  })

  it("reports a non-numeric usage as unmeasured instead of NaN", () => {
    const file = write("nan.jsonl", [
      tokenCount({ input_tokens: "lots", output_tokens: null }, { input_tokens: "lots" }),
    ])
    const read = readRollout({ file })
    expect(read.turns[0]?.measured).toBe(false)
    expect(read.source).toBe("counted")
    expect(Number.isNaN(sum(read.tokens))).toBe(false)
    expect(sum(read.tokens)).toBe(0)
  })
})

describe("readRollout session facts", () => {
  it("reads cwd, context window and cli version, which the hook input does not carry", () => {
    const file = write("meta.jsonl", [meta("/home/u/proj"), tokenCount(usage(10, 0, 5, 0, 15), undefined)])
    const read = readRollout({ file })
    // No `cwd` in a Codex hook payload (docs §9h), so this is the only way a
    // handoff note gets scoped to a project.
    expect(read.cwd).toBe("/home/u/proj")
    expect(read.contextWindow).toBe(272_000)
    expect(read.cliVersion).toBe("0.146.0")
  })

  it("counts malformed and truncated lines instead of throwing on them", () => {
    const file = write("broken.jsonl", [
      meta("/home/u/proj"),
      "{not json",
      "[1,2,3]",
      line("response_item", { type: "message", content: "a real conversation turn" }),
      tokenCount(usage(10, 0, 5, 0, 15), undefined),
    ])
    const read = readRollout({ file })
    expect(read.skipped).toBe(2)
    expect(read.lines).toBe(5)
    // A response_item is not skipped, just not a token record: nothing in this
    // reader ever touches conversation content.
    expect(read.turns).toHaveLength(1)
  })

  it("keeps cwd from the head when only part of a huge file is read", () => {
    const filler = Array.from({ length: 200 }, () => line("response_item", { type: "message", content: "x".repeat(200) }))
    const file = write("huge.jsonl", [meta("/home/u/big"), ...filler, tokenCount(usage(9, 0, 1, 0, 10), undefined)])
    // Below the file size, so the head+tail path runs.
    const read = readRollout({ file, maxBytes: 4_096 })
    expect(read.partial).toBe(true)
    // The tail-only read this replaced lost `cwd` on exactly the big sessions.
    expect(read.cwd).toBe("/home/u/big")
    expect(read.tokens.input).toBeDefined()
  })

  it("does not decode the uninitialised part of its read buffer", () => {
    const file = write("short.jsonl", [meta("/home/u/short")])
    const read = readRollout({ file, maxBytes: 16 })
    // allocUnsafe returns dirty memory; slicing at the allocation instead of at
    // the reported byte count appends garbage to the last line.
    expect(read.partial).toBe(true)
    expect(read.skipped).toBeLessThanOrEqual(read.lines)
  })
})

describe("readRollout failure modes", () => {
  it("reports a missing file as missing, with no spend claimed", () => {
    const read = readRollout({ file: path.join(root, "nope.jsonl") })
    expect(read.source).toBe("missing")
    expect(read.reason).toBe("ENOENT")
    expect(sum(read.tokens)).toBe(0)
  })

  it("reports an unreadable path as unreadable rather than throwing", () => {
    const dir = path.join(root, "a-directory")
    fs.mkdirSync(dir, { recursive: true })
    const read = readRollout({ file: dir })
    expect(read.source).toBe("unreadable")
    expect(read.reason).toBeTruthy()
  })

  it("is missing, not a crash, when no session id resolves to a file", () => {
    const read = readRollout({ sessionId: "unknown-id", sessionsDir: root })
    expect(read.source).toBe("missing")
    expect(read.path).toBe("")
  })
})

describe("rolloutPath", () => {
  it("finds a rollout by the id in its filename, whatever date directory it is under", () => {
    const id = "0199a1b2-c3d4-7000-8000-00000000abcd"
    const dir = path.join(root, "sessions", "2026", "09", "16")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `rollout-2026-09-16T23-50-00-${id}.jsonl`)
    fs.writeFileSync(file, `${tokenCount(usage(10, 0, 5, 0, 15), undefined)}\n`)
    // Never computed from a date: the directory is local time while
    // session_meta.timestamp is UTC (docs §9g), so a computed YYYY/MM/DD misses
    // for part of every day.
    expect(rolloutPath({ sessionId: id, sessionsDir: path.join(root, "sessions") })).toBe(file)
    expect(readRollout({ sessionId: id, sessionsDir: path.join(root, "sessions") }).source).toBe("measured")
  })

  it("refuses an id that could walk out of the sessions directory", () => {
    // The id arrives from a hook payload, so it is untrusted input.
    expect(rolloutPath({ sessionId: "../../etc/passwd", sessionsDir: root })).toBeUndefined()
    expect(rolloutPath({ sessionId: "a/b", sessionsDir: root })).toBeUndefined()
  })
})
