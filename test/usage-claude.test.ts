// The transcript is an undocumented, explicitly-unstable file. Every test here
// is therefore one of two questions: does it read the real shape correctly, and
// does it degrade instead of throwing when the shape is not the real one.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { addTokens, projectSlug, readTranscript, transcriptPath } from "../src/usage/claude.js"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-norm-claude-"))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A line shaped like the ones on disk, including the breakdown fields that
 * must NOT be summed into the totals. */
function assistant(o: {
  id: string
  block?: number
  input?: unknown
  output?: unknown
  thinking?: number
  read?: number
  write?: number
  sidechain?: boolean
}): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `${o.id}-${o.block ?? 0}`,
    sessionId: "ses_test",
    requestId: `req_${o.id}`,
    apiBlockIndex: o.block ?? 0,
    isSidechain: o.sidechain ?? false,
    timestamp: "2026-09-17T10:00:00.000Z",
    message: {
      id: o.id,
      role: "assistant",
      usage: {
        input_tokens: o.input ?? 2,
        cache_creation_input_tokens: o.write ?? 0,
        cache_read_input_tokens: o.read ?? 0,
        output_tokens: o.output ?? 0,
        output_tokens_details: { thinking_tokens: o.thinking ?? 0 },
        cache_creation: { ephemeral_5m_input_tokens: 999, ephemeral_1h_input_tokens: 999 },
        iterations: [{ input_tokens: 999, output_tokens: 999, type: "message" }],
        service_tier: "standard",
      },
    },
  })
}

function write(name: string, lines: string[], trailingNewline = true): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, lines.join("\n") + (trailingNewline ? "\n" : ""))
  return file
}

describe("reading the real shape", () => {
  it("maps all five usage fields onto RawTokens", () => {
    const file = write("a.jsonl", [
      assistant({ id: "msg_1", input: 11, output: 1959, thinking: 1477, read: 49689, write: 7669 }),
    ])
    const read = readTranscript({ file })

    expect(read.source).toBe("measured")
    expect(read.tokens).toEqual({
      input: 11,
      output: 1959,
      reasoning: 1477,
      cache: { read: 49689, write: 7669 },
    })
  })

  it("ignores iterations[] and cache_creation{} -- breakdowns, not addends", () => {
    // Both carry 999s above; if either were summed the totals would not match.
    const file = write("a.jsonl", [assistant({ id: "msg_1", input: 1, output: 2, write: 3 })])
    const read = readTranscript({ file })
    expect(read.tokens.input).toBe(1)
    expect(read.tokens.output).toBe(2)
    expect(read.tokens.cache?.write).toBe(3)
  })

  it("keeps cumulative and latest apart", () => {
    // cache_read is the whole window re-read every turn: summing it answers
    // "what did this session cost", never "how full is the window now".
    const file = write("a.jsonl", [
      assistant({ id: "msg_1", read: 100, output: 10 }),
      assistant({ id: "msg_2", read: 100, output: 10 }),
    ])
    const read = readTranscript({ file })
    expect(read.tokens.cache?.read).toBe(200)
    expect(read.latest?.cache?.read).toBe(100)
  })

  it("records subagent turns without filtering them", () => {
    const file = write("a.jsonl", [assistant({ id: "msg_1", sidechain: true })])
    expect(readTranscript({ file }).turns[0].sidechain).toBe(true)
  })

  it("counts only assistant lines", () => {
    const file = write("a.jsonl", [
      JSON.stringify({ type: "user", message: { role: "user" } }),
      JSON.stringify({ type: "attachment" }),
      assistant({ id: "msg_1", output: 5 }),
    ])
    const read = readTranscript({ file })
    expect(read.turns).toHaveLength(1)
    expect(read.tokens.output).toBe(5)
  })
})

describe("the dedup trap", () => {
  it("collapses the content-block lines that repeat one message's usage", () => {
    // Measured on a real transcript: 21 assistant lines, 6 distinct message ids,
    // every block repeating the same usage object. Summing lines overcounted
    // output by 3.75x. Four blocks of one message must read as one turn.
    const file = write("a.jsonl", [
      assistant({ id: "msg_1", block: 0, output: 2972, read: 49689 }),
      assistant({ id: "msg_1", block: 1, output: 2972, read: 49689 }),
      assistant({ id: "msg_1", block: 2, output: 2972, read: 49689 }),
      assistant({ id: "msg_1", block: 3, output: 2972, read: 49689 }),
    ])
    const read = readTranscript({ file })

    expect(read.turns).toHaveLength(1)
    expect(read.tokens.output).toBe(2972)
    expect(read.tokens.cache?.read).toBe(49689)
  })

  it("falls back to requestId, then uuid, when message.id is gone", () => {
    const noId = JSON.stringify({
      type: "assistant",
      uuid: "u-1",
      requestId: "req_9",
      message: { role: "assistant", usage: { output_tokens: 7 } },
    })
    const read = readTranscript({ file: write("a.jsonl", [noId, noId]) })
    expect(read.turns).toHaveLength(1)
    expect(read.tokens.output).toBe(7)

    const noReq = JSON.stringify({
      type: "assistant",
      uuid: "u-2",
      message: { role: "assistant", usage: { output_tokens: 7 } },
    })
    expect(readTranscript({ file: write("b.jsonl", [noReq, noReq]) }).turns).toHaveLength(1)
  })
})

describe("degrading instead of throwing", () => {
  it("reads every complete line of a truncated file", () => {
    const good = assistant({ id: "msg_1", output: 10 })
    const also = assistant({ id: "msg_2", output: 20 })
    const file = write("a.jsonl", [good, also, '{"type":"assistant","mess'], false)

    const read = readTranscript({ file })
    expect(read.source).toBe("measured")
    expect(read.skipped).toBe(1)
    expect(read.measuredTurns).toBe(2)
    expect(read.tokens.output).toBe(30)
  })

  it("degrades to call-counting when the schema is unrecognizable", () => {
    const renamed = (id: string) =>
      JSON.stringify({
        type: "assistant",
        uuid: id,
        message: { id, role: "assistant", usage: { prompt_tokens: 10, completion_tokens: 20 } },
      })
    const read = readTranscript({ file: write("a.jsonl", [renamed("m1"), renamed("m2")]) })

    expect(read.source).toBe("counted")
    expect(read.turns).toHaveLength(2) // the call count survives
    expect(read.measuredTurns).toBe(0)
    expect(read.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    expect(read.reason).toMatch(/count turns/)
  })

  it("counts turns when usage is missing entirely", () => {
    const read = readTranscript({
      file: write("a.jsonl", [JSON.stringify({ type: "assistant", uuid: "u1", message: { id: "m1" } })]),
    })
    expect(read.source).toBe("counted")
    expect(read.turns).toHaveLength(1)
  })

  it("reports a missing file rather than failing", () => {
    const read = readTranscript({ file: path.join(dir, "nope.jsonl") })
    expect(read.source).toBe("missing")
    expect(read.turns).toEqual([])
    expect(read.tokens.output).toBe(0)
  })

  it("reports an unreadable path rather than failing", () => {
    const read = readTranscript({ file: dir }) // a directory: EISDIR on read
    expect(read.source).toBe("unreadable")
    expect(read.reason).toBeTruthy()
  })

  it("has nothing to say without a session id", () => {
    const read = readTranscript({ projectsDir: dir, cwd: "/tmp/x" })
    expect(read.source).toBe("missing")
    expect(read.reason).toBe("no session id")
  })

  it("survives lines that are valid JSON but not objects", () => {
    const file = write("a.jsonl", ["null", "[]", '"a string"', "123", "", "{}", assistant({ id: "m", output: 4 })])
    const read = readTranscript({ file })
    expect(read.source).toBe("measured")
    expect(read.tokens.output).toBe(4)
  })

  it("rejects numbers that are not counts", () => {
    const file = write("a.jsonl", [assistant({ id: "m1", input: -5, output: "12" })])
    const read = readTranscript({ file })
    expect(read.tokens.input).toBe(0)
    expect(read.tokens.output).toBe(0)
    expect(read.turns[0].measured).toBe(true) // cache fields still read
  })

  it("reads the tail of an oversized file and drops the cut line", () => {
    const lines = Array.from({ length: 50 }, (_, i) => assistant({ id: `msg_${i}`, output: 10 }))
    const file = write("a.jsonl", lines)
    const read = readTranscript({ file, maxBytes: 2000 })

    expect(read.partial).toBe(true)
    expect(read.source).toBe("measured")
    expect(read.turns.length).toBeGreaterThan(0)
    expect(read.turns.length).toBeLessThan(50)
  })
})

describe("locating the transcript", () => {
  it("slugifies a cwd the way the host does", () => {
    // Both pinned against directories observed in ~/.claude/projects.
    expect(projectSlug("/home/u/Desktop/code/token-norm")).toBe("-home-u-Desktop-code-token-norm")
    expect(projectSlug("/home/u/.openclaw/workspace")).toBe("-home-u--openclaw-workspace")
  })

  it("composes projectsDir + slug + id", () => {
    expect(transcriptPath({ sessionId: "ses_1", cwd: "/a/b", projectsDir: "/p" })).toBe(
      path.join("/p", "-a-b", "ses_1.jsonl"),
    )
  })

  it("cannot be walked out of the projects directory by a hostile id", () => {
    const file = transcriptPath({ sessionId: "../../etc/passwd", cwd: "/a", projectsDir: "/p" })
    expect(file.startsWith(path.join("/p", "-a") + path.sep)).toBe(true)
    expect(file).not.toContain("..")
  })

  it("honours the projects-dir override", () => {
    const slug = projectSlug("/a/b")
    fs.mkdirSync(path.join(dir, slug), { recursive: true })
    fs.writeFileSync(path.join(dir, slug, "ses_1.jsonl"), assistant({ id: "m", output: 8 }) + "\n")

    const read = readTranscript({ sessionId: "ses_1", cwd: "/a/b", projectsDir: dir })
    expect(read.source).toBe("measured")
    expect(read.tokens.output).toBe(8)
  })
})

describe("addTokens", () => {
  it("sums each axis and treats absent as zero", () => {
    expect(addTokens({ input: 1, cache: { read: 2 } }, { output: 3, cache: { write: 4 } })).toEqual({
      input: 1,
      output: 3,
      reasoning: 0,
      cache: { read: 2, write: 4 },
    })
  })
})
