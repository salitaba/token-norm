// The disk backend exists so a counter can outlive the process that
// incremented it. Every test here is ultimately about one of two failures:
// a reload that loses state, or a concurrent write that rolls it back.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DiskStore, MemoryStore, fileNameFor } from "../src/runtime/store.js"
import { SEEN_MESSAGES_MAX, emptySessionState, stateCodec, type SessionState } from "../src/core/budget/state.js"
import { POLICY_STATES, ordinal, type PolicyState } from "../src/core/budget/policy.js"

const ID = "ses_abc123"
const NUL = String.fromCharCode(0)

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-norm-store-"))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A fresh store on the same directory is what a second hook process is. */
function reopen(): DiskStore<SessionState> {
  return new DiskStore(dir, stateCodec)
}

function populated(): SessionState {
  const s = emptySessionState()
  s.calls = 7
  s.weightedCalls = 11.5
  s.announced = true
  s.lastAudit = 60
  s.tools.set("bash", 4)
  s.tools.set("read", 3)
  s.seenMessages.add("msg_1").add("msg_2")
  s.pendingBoundary = true
  s.crossed.add("cost").add("context")
  s.level = "PRESSURE"
  s.axisLevels = { calls: "ATTENTION", context: "PRESSURE" }
  return s
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe("filename derivation", () => {
  it("passes an ordinary session id through untouched", () => {
    expect(fileNameFor("ses_abc123")).toBe("ses_abc123.json")
  })

  it("never lets an id escape the directory it is joined into", () => {
    for (const hostile of ["../../.bashrc", "/etc/passwd", "..", ".", "a/b/c", `x${NUL}y`]) {
      const resolved = path.resolve("/state", fileNameFor(hostile))
      expect(path.dirname(resolved)).toBe(path.resolve("/state"))
    }
  })

  it("does not merge two different ids onto one file after sanitising", () => {
    // Character replacement alone maps both of these to "a_b", which would
    // silently pool two unrelated sessions' counters into one record.
    expect(fileNameFor("a/b")).not.toBe(fileNameFor("a:b"))
  })

  it("is deterministic across calls", () => {
    expect(fileNameFor("a/b")).toBe(fileNameFor("a/b"))
  })
})

describe("MemoryStore", () => {
  it("behaves as the Map the plugin has always held", () => {
    const store = new MemoryStore<SessionState>()
    const s = emptySessionState()
    store.set(ID, s)
    expect(store.get(ID)).toBe(s)
    expect(store.has(ID)).toBe(true)
    expect(store.size).toBe(1)
    expect(store.keys()).toEqual([ID])
    s.calls = 3
    store.save(ID)
    expect(store.get(ID)?.calls).toBe(3)
    expect(store.delete(ID)).toBe(true)
    expect(store.get(ID)).toBeUndefined()
    store.set(ID, emptySessionState())
    store.clear()
    expect(store.size).toBe(0)
  })
})

describe("serialization", () => {
  it("round-trips Sets and Maps through JSON", () => {
    const original = populated()
    const decoded = stateCodec.decode(JSON.parse(JSON.stringify(stateCodec.encode(original))))
    expect(decoded).toEqual(original)
    expect(decoded?.tools).toBeInstanceOf(Map)
    expect(decoded?.seenMessages).toBeInstanceOf(Set)
    expect(decoded?.crossed).toBeInstanceOf(Set)
  })

  it("survives a real write and read as a distinct process would do it", () => {
    const writer = reopen()
    writer.set(ID, populated())
    writer.save(ID)
    expect(reopen().get(ID)).toEqual(populated())
  })

  it("keeps the seen-message cap on the way back in", () => {
    const s = emptySessionState()
    for (let i = 0; i < SEEN_MESSAGES_MAX + 50; i++) s.seenMessages.add(`msg_${i}`)
    const decoded = stateCodec.decode(stateCodec.encode(s))
    expect(decoded?.seenMessages.size).toBe(SEEN_MESSAGES_MAX)
    // Oldest evicted, newest retained: the recent ones are what dedupe is for.
    expect(decoded?.seenMessages.has("msg_0")).toBe(false)
    expect(decoded?.seenMessages.has(`msg_${SEEN_MESSAGES_MAX + 49}`)).toBe(true)
  })

  it("defaults missing fields instead of discarding the record", () => {
    const decoded = stateCodec.decode({ calls: 5, level: "PRESSURE" })
    expect(decoded?.calls).toBe(5)
    expect(decoded?.level).toBe("PRESSURE")
    expect(decoded?.weightedCalls).toBe(0)
    expect(decoded?.tools.size).toBe(0)
    expect(decoded?.axisLevels).toEqual({})
  })

  it("drops junk field values rather than trusting them into the record", () => {
    const decoded = stateCodec.decode({
      calls: "many",
      weightedCalls: Number.NaN,
      announced: 1,
      level: "CATASTROPHIC",
      tools: [["bash", 2], ["bad"], [7, 7], ["ok", "no"]],
      crossed: ["cost", 42, null],
      axisLevels: { calls: "PRESSURE", context: "NOPE" },
    })
    expect(decoded?.calls).toBe(0)
    expect(decoded?.weightedCalls).toBe(0)
    expect(decoded?.announced).toBe(false)
    expect(decoded?.level).toBe("HEALTHY")
    expect([...(decoded?.tools ?? [])]).toEqual([["bash", 2]])
    expect([...(decoded?.crossed ?? [])]).toEqual(["cost"])
    expect(decoded?.axisLevels).toEqual({ calls: "PRESSURE" })
  })

  it("rejects input that is not a record at all", () => {
    for (const raw of [undefined, null, 4, "state", [1, 2]]) {
      expect(stateCodec.decode(raw)).toBeUndefined()
    }
  })
})

describe("degradation", () => {
  it("reports no prior state for a session it has never seen", () => {
    expect(reopen().get("ses_unknown")).toBeUndefined()
  })

  it("does not throw on a truncated or corrupt file", () => {
    fs.writeFileSync(path.join(dir, `${ID}.json`), '{"v":1,"id":"ses_abc123","state":{"calls":')
    const store = reopen()
    expect(() => store.get(ID)).not.toThrow()
    expect(store.get(ID)).toBeUndefined()
  })

  it("does not throw when the state directory cannot be written", () => {
    // A path whose parent is a regular file: mkdir fails with ENOTDIR, fast and
    // identically on every platform. (Do not reach for /proc here -- mkdirSync
    // under it does not return at all on some kernels, which hangs the run
    // rather than failing it.)
    const blocker = path.join(dir, "not-a-dir")
    fs.writeFileSync(blocker, "")
    const store = new DiskStore<SessionState>(path.join(blocker, "state"), stateCodec)
    store.set(ID, populated())
    expect(() => store.save(ID)).not.toThrow()
    expect(() => store.clear()).not.toThrow()
    expect(() => store.keys()).not.toThrow()
  })

  it("leaves no temp file behind after a successful write", () => {
    const store = reopen()
    store.set(ID, populated())
    store.save(ID)
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([])
  })

  it("reports ids, not mangled filenames", () => {
    const store = reopen()
    store.set("a/b", emptySessionState())
    store.save("a/b")
    expect(reopen().keys()).toEqual(["a/b"])
    expect(reopen().get("a/b")).toBeDefined()
  })

  it("deletes a session's file", () => {
    const store = reopen()
    store.set(ID, populated())
    store.save(ID)
    expect(store.delete(ID)).toBe(true)
    expect(reopen().get(ID)).toBeUndefined()
  })
})

describe("the monotone level invariant across a reload", () => {
  it("does not walk severity back down when the process restarts", () => {
    const first = reopen()
    const s = emptySessionState()
    s.level = "HANDOFF_RECOMMENDED"
    first.set(ID, s)
    first.save(ID)
    expect(reopen().get(ID)?.level).toBe("HANDOFF_RECOMMENDED")
  })

  it("holds for every state in the ladder", () => {
    for (const level of POLICY_STATES) {
      const store = reopen()
      const s = emptySessionState()
      s.level = level
      store.set(ID, s)
      store.save(ID)
      expect(reopen().get(ID)?.level).toBe(level)
      store.delete(ID)
    }
  })

  it("refuses to let a stale writer lower the stored level", () => {
    const first = reopen()
    const s = emptySessionState()
    s.level = "PRESSURE"
    first.set(ID, s)
    first.save(ID)

    // A process that read before the escalation, still holding HEALTHY.
    const stale = reopen()
    const held = stale.get(ID)!
    held.level = "HEALTHY"
    stale.save(ID)

    expect(reopen().get(ID)?.level).toBe("PRESSURE")
  })

  it("keeps a crossed threshold crossed, so its reminder cannot re-fire", () => {
    const first = reopen()
    const a = emptySessionState()
    a.crossed.add("cost")
    first.set(ID, a)
    first.save(ID)

    const second = reopen()
    const b = second.get(ID)!
    b.crossed.delete("cost")
    b.crossed.add("context")
    second.save(ID)

    expect([...reopen().get(ID)!.crossed].sort()).toEqual(["context", "cost"])
  })

  it("lets a consumed pause flag stay consumed instead of resurrecting it", () => {
    const first = reopen()
    const a = emptySessionState()
    a.pendingHandoff = true
    first.set(ID, a)
    first.save(ID)

    const second = reopen()
    const b = second.get(ID)!
    b.pendingHandoff = false
    second.save(ID)

    expect(reopen().get(ID)?.pendingHandoff).toBe(false)
  })

  it("takes the freshest axis reading rather than the largest", () => {
    const first = reopen()
    const a = emptySessionState()
    a.axisLevels = { context: "PRESSURE" }
    first.set(ID, a)
    first.save(ID)

    const second = reopen()
    const b = second.get(ID)!
    b.axisLevels = { context: "HEALTHY" }
    second.save(ID)

    // axisLevels is "how bad is it now"; level is the high-water mark.
    expect(reopen().get(ID)?.axisLevels).toEqual({ context: "HEALTHY" })
  })
})

describe("concurrent hook processes", () => {
  it("does not let the slower writer erase the faster one's increment", () => {
    const base = reopen()
    base.set(ID, emptySessionState())
    base.save(ID)

    const a = reopen()
    const b = reopen()
    const sa = a.get(ID)!
    const sb = b.get(ID)!

    sa.calls = 5
    sa.tools.set("bash", 5)
    sa.crossed.add("cost")
    sa.level = "ATTENTION"
    a.save(ID)

    // b read the same base and finishes second with a lower count.
    sb.calls = 2
    sb.tools.set("read", 2)
    sb.crossed.add("context")
    b.save(ID)

    const merged = reopen().get(ID)!
    expect(merged.calls).toBe(5)
    expect(merged.tools.get("bash")).toBe(5)
    expect(merged.tools.get("read")).toBe(2)
    expect([...merged.crossed].sort()).toEqual(["context", "cost"])
    expect(merged.level).toBe("ATTENTION")
  })

  it("keeps the announce latch set once either writer has set it", () => {
    const base = reopen()
    base.set(ID, emptySessionState())
    base.save(ID)

    const a = reopen()
    a.get(ID)!.announced = true
    a.save(ID)

    const b = reopen()
    // b never saw the announcement and still holds false.
    b.get(ID)
    b.save(ID)

    expect(reopen().get(ID)?.announced).toBe(true)
  })

  it("never decreases a counter or the level under seeded interleaved replay", () => {
    const rnd = mulberry32(0x5eed)
    const base = reopen()
    base.set(ID, emptySessionState())
    base.save(ID)

    let seenCalls = 0
    let seenLevel = 0

    for (let round = 0; round < 300; round++) {
      // Two to four processes read the same snapshot, then write in a random
      // order -- the shape of overlapping PreToolUse/PostToolUse hooks.
      const workers = 2 + Math.floor(rnd() * 3)
      const stores = Array.from({ length: workers }, () => reopen())
      const held = stores.map((store) => ({ store, s: store.get(ID)! }))

      for (const { s } of held) {
        s.calls += Math.floor(rnd() * 3)
        s.weightedCalls += rnd() * 2
        if (rnd() < 0.15) {
          s.level = POLICY_STATES[Math.floor(rnd() * POLICY_STATES.length)] as PolicyState
        }
        if (rnd() < 0.2) s.crossed.add(`metric_${Math.floor(rnd() * 5)}`)
      }

      for (const { store } of held.sort(() => rnd() - 0.5)) store.save(ID)

      const after = reopen().get(ID)!
      expect(after.calls).toBeGreaterThanOrEqual(seenCalls)
      expect(ordinal(after.level)).toBeGreaterThanOrEqual(seenLevel)
      seenCalls = after.calls
      seenLevel = ordinal(after.level)
    }

    expect(seenCalls).toBeGreaterThan(0)
  })
})
