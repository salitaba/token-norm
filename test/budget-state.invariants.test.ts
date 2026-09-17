import { beforeEach, describe, expect, it } from "vitest"
import {
  CONTEXT_KEY,
  evaluatePolicy,
  maxState,
  ordinal,
  renderPolicy,
  type BudgetMetric,
  type PolicyInput,
  type PolicySections,
  type PolicyState,
} from "../src/core/budget/policy.js"
import { ANNOUNCE_AT, type BudgetMode } from "../src/core/config.js"
import { recommendationFor, snapshotFrom } from "../src/status.js"
import { state, track } from "../src/core/budget/state.js"
import { UsageTracker, type StepTokens } from "../src/core/usage.js"

const ROOT = "ses_root"
const CHEAP = new Set(["todowrite", "question", "skill"])
const TOOLS = ["read", "bash", "edit", "todowrite", "question", "skill"]
const EPSILON = 1e-9

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rnd: () => number, list: T[]): T {
  return list[Math.floor(rnd() * list.length)] as T
}

let partSeq = 0

function randomTokens(rnd: () => number): StepTokens {
  return {
    input: Math.floor(rnd() * 1000),
    output: Math.floor(rnd() * 500),
    reasoning: 0,
    cache: { read: Math.floor(rnd() * 500), write: Math.floor(rnd() * 100) },
  }
}

function tokens(input = 0): StepTokens {
  return { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function step(tracker: UsageTracker, sessionID: string, t: StepTokens, cost: number): void {
  tracker.handleEvent({
    type: "message.part.updated",
    properties: { part: { id: `part_${partSeq++}`, sessionID, type: "step-finish", cost, tokens: t } },
  })
}

interface EntrySnapshot {
  cost: number
  effective: number
  steps: number
  calls: number
}

function entrySnapshot(tracker: UsageTracker, id: string): EntrySnapshot {
  const s = tracker.get(id)
  return { cost: s.costUsd, effective: s.effectiveTokens, steps: s.stepCount, calls: s.calls }
}

function ledgerTotal(tracker: UsageTracker, ids: string[]): { cost: number; effective: number } {
  let cost = 0
  let effective = 0
  for (const id of ids) {
    if (!tracker.has(id)) continue
    const s = tracker.get(id)
    cost += s.costUsd + (s.folded?.costUsd ?? 0)
    effective += s.effectiveTokens + (s.folded?.effectiveTokens ?? 0)
  }
  return { cost, effective }
}

beforeEach(() => {
  state.clear()
})

describe("usage ledger invariants (seeded randomized replay)", () => {
  it("never decreases per-session counters or the conserved ledger total", () => {
    const tracker = new UsageTracker()
    const rnd = mulberry32(0x5eed0001)
    const created = [ROOT]
    const live = [ROOT]
    const snapshots = new Map<string, EntrySnapshot>()
    tracker.handleEvent({ type: "session.created", properties: { info: { id: ROOT } } })
    snapshots.set(ROOT, entrySnapshot(tracker, ROOT))
    let total = ledgerTotal(tracker, created)
    const failures: string[] = []

    for (let i = 0; i < 700; i++) {
      const roll = rnd()
      if (roll < 0.28) {
        const id = `ses_${created.length}`
        const parent = pick(rnd, live)
        created.push(id)
        live.push(id)
        tracker.handleEvent({ type: "session.created", properties: { info: { id, parentID: parent } } })
        snapshots.set(id, entrySnapshot(tracker, id))
      } else if (roll < 0.62) {
        const id = pick(rnd, live)
        step(tracker, id, randomTokens(rnd), rnd() * 0.5)
        tracker.noteToolCall(id, pick(rnd, TOOLS), {}, { output: "x".repeat(1 + Math.floor(rnd() * 30)) }, rnd() < 0.7)
      } else if (roll < 0.72) {
        tracker.handleEvent({ type: "session.compacted", properties: { sessionID: pick(rnd, live) } })
      } else if (roll < 0.78) {
        const id = pick(rnd, live)
        tracker.handleEvent({
          type: "message.updated",
          properties: { info: { role: "assistant", sessionID: id, providerID: "p", modelID: "m" } },
        })
      } else if (roll < 0.86) {
        const movable = live.filter((id) => id !== ROOT)
        if (movable.length > 0) {
          const id = pick(rnd, movable)
          tracker.handleEvent({ type: "session.updated", properties: { info: { id, parentID: ROOT } } })
        }
      } else if (live.length > 1) {
        const id = pick(rnd, live.filter((x) => x !== ROOT))
        const before = ledgerTotal(tracker, created)
        tracker.handleEvent({ type: "session.deleted", properties: { info: { id } } })
        live.splice(live.indexOf(id), 1)
        snapshots.delete(id)

        step(tracker, id, randomTokens(rnd), 5)
        tracker.noteToolCall(id, "read", { filePath: "/tmp/zombie" }, { output: "zzz" }, true)
        tracker.handleEvent({ type: "session.updated", properties: { info: { id, parentID: ROOT } } })

        if (tracker.has(id)) failures.push(`deleted ${id} was resurrected`)
        const after = ledgerTotal(tracker, created)
        if (after.cost < before.cost - EPSILON || after.effective < before.effective - EPSILON) {
          failures.push(`delete of ${id} lost ledger value: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
        }
      }

      for (const id of live) {
        if (!tracker.has(id)) continue
        const now = entrySnapshot(tracker, id)
        const prev = snapshots.get(id)
        if (
          prev &&
          (now.cost < prev.cost - EPSILON ||
            now.effective < prev.effective - EPSILON ||
            now.steps < prev.steps ||
            now.calls < prev.calls)
        ) {
          failures.push(`${id} decreased: ${JSON.stringify(prev)} -> ${JSON.stringify(now)}`)
        }
        snapshots.set(id, now)
      }

      const nowTotal = ledgerTotal(tracker, created)
      if (nowTotal.cost < total.cost - EPSILON || nowTotal.effective < total.effective - EPSILON) {
        failures.push(`ledger total decreased at event ${i}: ${JSON.stringify(total)} -> ${JSON.stringify(nowTotal)}`)
      }
      total = nowTotal
    }

    expect(failures).toEqual([])
    expect(created.length).toBeGreaterThan(50)
  })

  it("never decreases the root rollup while the root lives", () => {
    const tracker = new UsageTracker()
    const rnd = mulberry32(0x5eed0002)
    const created = [ROOT]
    const live = [ROOT]
    tracker.handleEvent({ type: "session.created", properties: { info: { id: ROOT } } })
    let prev = tracker.rollup(ROOT)
    const failures: string[] = []

    for (let i = 0; i < 500; i++) {
      const roll = rnd()
      if (roll < 0.3) {
        const id = `roll_${created.length}`
        const parent = pick(rnd, live)
        created.push(id)
        live.push(id)
        tracker.handleEvent({ type: "session.created", properties: { info: { id, parentID: parent } } })
      } else if (roll < 0.75) {
        const id = pick(rnd, live)
        step(tracker, id, randomTokens(rnd), rnd() * 0.4)
        tracker.noteToolCall(id, pick(rnd, TOOLS), {}, { output: "y".repeat(1 + Math.floor(rnd() * 20)) }, rnd() < 0.6)
      } else if (roll < 0.85) {
        tracker.handleEvent({ type: "session.compacted", properties: { sessionID: pick(rnd, live) } })
      } else if (live.length > 1) {
        const id = pick(rnd, live.filter((x) => x !== ROOT))
        tracker.handleEvent({ type: "session.deleted", properties: { info: { id } } })
        live.splice(live.indexOf(id), 1)
      }

      const now = tracker.rollup(ROOT)
      if (
        now.costUsd < prev.costUsd - EPSILON ||
        now.effectiveTokens < prev.effectiveTokens - EPSILON ||
        now.stepCount < prev.stepCount ||
        now.calls < prev.calls ||
        now.sessions < prev.sessions
      ) {
        failures.push(`rollup decreased at event ${i}: ${JSON.stringify(prev)} -> ${JSON.stringify(now)}`)
      }
      prev = now
    }

    expect(failures).toEqual([])
    expect(live.length).toBeGreaterThan(20)
  })
})

describe("deletion semantics", () => {
  it("folds a deleted session into its parent and reparents children to the surviving ancestor", () => {
    const tracker = new UsageTracker()
    tracker.handleEvent({ type: "session.created", properties: { info: { id: "ses_mid", parentID: ROOT } } })
    tracker.handleEvent({ type: "session.created", properties: { info: { id: "ses_leaf", parentID: "ses_mid" } } })
    step(tracker, "ses_mid", tokens(400), 0.4)
    step(tracker, "ses_leaf", tokens(200), 0.25)
    tracker.noteToolCall("ses_mid", "read", {}, { output: "xxxx" }, true)
    const before = tracker.rollup(ROOT)

    tracker.handleEvent({ type: "session.deleted", properties: { info: { id: "ses_mid" } } })

    expect(tracker.has("ses_mid")).toBe(false)
    expect(tracker.get("ses_leaf").parentID).toBe(ROOT)
    expect(tracker.get(ROOT).childIDs.has("ses_mid")).toBe(false)
    expect(tracker.get(ROOT).childIDs.has("ses_leaf")).toBe(true)
    expect(tracker.rootOf("ses_leaf")).toBe(ROOT)

    const after = tracker.rollup(ROOT)
    expect(after.sessions).toBe(before.sessions)
    expect(after.costUsd).toBeCloseTo(before.costUsd, 10)
    expect(after.effectiveTokens).toBeCloseTo(before.effectiveTokens, 10)
    expect(after.stepCount).toBe(before.stepCount)
    expect(after.calls).toBe(before.calls)
  })

  it("ignores late events addressed to a deleted id and does not resurrect it", () => {
    const tracker = new UsageTracker()
    tracker.handleEvent({ type: "session.created", properties: { info: { id: "ses_gone", parentID: ROOT } } })
    step(tracker, "ses_gone", tokens(100), 0.3)
    tracker.noteToolCall("ses_gone", "read", {}, { output: "abc" }, true)
    tracker.handleEvent({ type: "session.deleted", properties: { info: { id: "ses_gone" } } })
    const after = tracker.rollup(ROOT)

    step(tracker, "ses_gone", tokens(9999), 9)
    tracker.noteToolCall("ses_gone", "read", { filePath: "/tmp/z" }, { output: "zzzz" }, true)
    tracker.handleEvent({
      type: "message.updated",
      properties: { info: { role: "assistant", sessionID: "ses_gone", providerID: "p", modelID: "m" } },
    })
    tracker.handleEvent({ type: "session.updated", properties: { info: { id: "ses_gone", parentID: ROOT } } })

    expect(tracker.has("ses_gone")).toBe(false)
    const later = tracker.rollup(ROOT)
    expect(later.costUsd).toBeCloseTo(after.costUsd, 10)
    expect(later.effectiveTokens).toBeCloseTo(after.effectiveTokens, 10)
    expect(later.calls).toBe(after.calls)
    expect(later.stepCount).toBe(after.stepCount)
  })

  it("only a genuine session.created restarts a deleted id, adding to the folded past", () => {
    const tracker = new UsageTracker()
    tracker.handleEvent({ type: "session.created", properties: { info: { id: "ses_again", parentID: ROOT } } })
    step(tracker, "ses_again", tokens(1000), 0.5)
    tracker.handleEvent({ type: "session.deleted", properties: { info: { id: "ses_again" } } })

    tracker.handleEvent({ type: "session.created", properties: { info: { id: "ses_again", parentID: ROOT } } })
    step(tracker, "ses_again", tokens(100), 0.1)

    expect(tracker.has("ses_again")).toBe(true)
    expect(tracker.get("ses_again").costUsd).toBeCloseTo(0.1, 10)
    const rollup = tracker.rollup(ROOT)
    expect(rollup.costUsd).toBeCloseTo(0.6, 10)
    expect(rollup.sessions).toBe(3)
  })

  it("keeps suppressing an id evicted from the recent-deleted window", () => {
    const tracker = new UsageTracker()
    tracker.handleEvent({ type: "session.created", properties: { info: { id: "ses_evicted", parentID: ROOT } } })
    step(tracker, "ses_evicted", tokens(100), 0.5)
    tracker.handleEvent({ type: "session.deleted", properties: { info: { id: "ses_evicted" } } })
    const folded = tracker.rollup(ROOT)
    expect(folded.costUsd).toBeCloseTo(0.5, 10)
    expect(tracker.has("ses_evicted")).toBe(false)

    // More deletions than the recent-deleted window, so `ses_evicted` leaves
    // the exact set while its spend stays folded into ROOT.
    for (let i = 0; i < 550; i++) {
      const id = `ses_churn_${i}`
      tracker.handleEvent({ type: "session.created", properties: { info: { id, parentID: ROOT } } })
      tracker.handleEvent({ type: "session.deleted", properties: { info: { id } } })
    }

    step(tracker, "ses_evicted", tokens(9999), 9)
    tracker.noteToolCall("ses_evicted", "read", { filePath: "/tmp/zombie" }, { output: "zzzz" }, true)
    tracker.handleEvent({
      type: "message.updated",
      properties: { info: { role: "assistant", sessionID: "ses_evicted", providerID: "p", modelID: "m" } },
    })
    tracker.handleEvent({ type: "session.updated", properties: { info: { id: "ses_evicted", parentID: ROOT } } })

    expect(tracker.has("ses_evicted")).toBe(false)
    const after = tracker.rollup(ROOT)
    expect(after.costUsd).toBeCloseTo(folded.costUsd, 10)
    expect(after.stepCount).toBe(folded.stepCount)
    expect(after.calls).toBe(folded.calls)
    expect(after.sessions).toBe(folded.sessions + 550)
  })

  it("bounds tombstone false positives across many deletions", () => {
    const tracker = new UsageTracker()
    for (let i = 0; i < 20_000; i++) {
      const id = `ses_bulk_${i}`
      tracker.handleEvent({ type: "session.created", properties: { info: { id, parentID: ROOT } } })
      tracker.handleEvent({ type: "session.deleted", properties: { info: { id } } })
    }

    // These ids were never deleted or created. An unbounded filter collides
    // with ~25% of them after 20k deletions, so the tracker would silently
    // suppress late events for live sessions it has not seen this process.
    const probes = 2000
    let suppressed = 0
    for (let i = 0; i < probes; i++) {
      const id = `ses_probe_${i}`
      step(tracker, id, tokens(100), 0.1)
      if (!tracker.has(id)) suppressed++
    }

    expect(suppressed / probes).toBeLessThanOrEqual(0.05)
  })

  it("a deleted root has no parent, so its own totals leave the live ledger", () => {
    const tracker = new UsageTracker()
    tracker.handleEvent({ type: "session.created", properties: { info: { id: "ses_orphan", parentID: ROOT } } })
    step(tracker, ROOT, tokens(500), 0.7)
    step(tracker, "ses_orphan", tokens(100), 0.2)

    tracker.handleEvent({ type: "session.deleted", properties: { info: { id: ROOT } } })

    expect(tracker.has(ROOT)).toBe(false)
    expect(tracker.get("ses_orphan").parentID).toBeUndefined()
    expect(tracker.rootOf("ses_orphan")).toBe("ses_orphan")
    expect(tracker.rollup(ROOT).costUsd).toBe(0)
    expect(tracker.rollup(ROOT).sessions).toBe(0)
    expect(tracker.rollup("ses_orphan").costUsd).toBeCloseTo(0.2, 10)
  })
})

describe("SessionState call counters (seeded randomized tracking)", () => {
  it("counts non-cheap calls exactly and never decreases per session", () => {
    const rnd = mulberry32(0x5eed0003)
    const ids = ["ses_a", "ses_b", "ses_c"]
    const expected = new Map(ids.map((id) => [id, 0]))
    const snapshots = new Map<string, number>()

    for (let i = 0; i < 600; i++) {
      const id = pick(rnd, ids)
      const tool = pick(rnd, TOOLS)
      const s = track(id, tool)
      if (!CHEAP.has(tool)) expected.set(id, (expected.get(id) ?? 0) + 1)
      expect(s.calls).toBe(expected.get(id))
      expect(s.calls).toBeGreaterThanOrEqual(snapshots.get(id) ?? 0)
      snapshots.set(id, s.calls)
    }
  })

  it("excludes cheap tools from calls but still tracks them per tool", () => {
    const s = track("ses_cheap", "todowrite")
    track("ses_cheap", "question")
    track("ses_cheap", "skill")
    expect(s.calls).toBe(0)
    expect(s.tools.get("todowrite")).toBe(1)
    expect(s.tools.get("question")).toBe(1)
    expect(s.tools.get("skill")).toBe(1)

    track("ses_cheap", "read")
    expect(s.calls).toBe(1)
    expect(s.tools.get("read")).toBe(1)
    expect(track("ses_cheap", "read")).toBe(s)
    expect(s.calls).toBe(2)
    expect(s.tools.get("read")).toBe(2)
  })
})

// The policy machine is pure -- numbers in, verdict out -- so its guarantees
// can be checked directly instead of inferred from injected text.
describe("policy state machine invariants", () => {
  const CONTEXT_LIMIT = 1000
  const WARN_AT = CONTEXT_LIMIT * 0.8

  const contextMetric = (used: number) => ({
    key: CONTEXT_KEY,
    label: "Context now",
    used,
    limit: CONTEXT_LIMIT,
    warnAt: WARN_AT,
    format: (n: number) => `${n}`,
  })

  const callsMetric = (used: number, limit: number) => ({
    key: "tool-calls",
    label: "Tool calls",
    used,
    limit,
    warnAt: limit,
    format: (n: number) => `${n}`,
  })

  it("never decreases when the stored level is folded with max", () => {
    const rnd = mulberry32(0x5eed0004)
    let level: PolicyState = "HEALTHY"

    for (let i = 0; i < 500; i++) {
      // Deliberately non-monotone inputs: context swings freely, the pause
      // comes and goes, and the mode changes under the machine.
      const verdict = evaluatePolicy({
        calls: Math.floor(rnd() * 60),
        metrics: [contextMetric(Math.floor(rnd() * 1200))],
        mode: pick(rnd, ["observe", "warn", "handoff", "block"]),
        pauseArmed: rnd() < 0.5,
      })
      const next = maxState(level, verdict.state)
      expect(ordinal(next)).toBeGreaterThanOrEqual(ordinal(level))
      level = next
    }
    expect(ordinal(level)).toBeGreaterThan(ordinal("HEALTHY"))
  })

  // The reason the stored level is monotone: a metric sitting on its threshold
  // would otherwise re-arm every time it dipped, and re-fire forever.
  it("does not oscillate across the context warn boundary", () => {
    let level: PolicyState = "HEALTHY"
    let rises = 0

    for (let i = 0; i < 50; i++) {
      const used = i % 2 === 0 ? WARN_AT + 1 : WARN_AT - 1
      const verdict = evaluatePolicy({
        calls: 0,
        metrics: [contextMetric(used)],
        mode: "warn",
        pauseArmed: false,
      })
      const next = maxState(level, verdict.state)
      if (ordinal(next) > ordinal(level)) rises++
      level = next
    }

    // One rise for 25 crossings: the reminder fires on the first, and the
    // other 24 are the wallpaper this design exists to prevent.
    expect(rises).toBe(1)
    expect(level).toBe("PRESSURE")
  })

  it("takes the max across axes and names the driver", () => {
    const quiet = evaluatePolicy({ calls: 0, metrics: [], mode: "warn", pauseArmed: false })
    expect(quiet.state).toBe("HEALTHY")

    // Calls alone stop at ATTENTION: a long session is expensive, not endangered.
    const long = evaluatePolicy({ calls: 500, metrics: [], mode: "warn", pauseArmed: false })
    expect(long.state).toBe("ATTENTION")
    expect(long.driver.name).toBe("calls")

    // A budget crossing outranks the call count, and says so in the header.
    const overBudget = evaluatePolicy({
      calls: 500,
      metrics: [callsMetric(10, 10)],
      mode: "warn",
      pauseArmed: false,
    })
    expect(overBudget.state).toBe("PRESSURE")
    expect(overBudget.driver.name).toBe("budget")
    expect(overBudget.exceeded).toBe(true)
  })

  it("applies the mode after the max, never inside an axis", () => {
    const metrics = [callsMetric(10, 10)]

    // Observe measures exactly what warn measures. The suppression is at
    // render time, so token_norm_status keeps telling the truth.
    expect(evaluatePolicy({ calls: 0, metrics, mode: "observe", pauseArmed: true }).state).toBe("PRESSURE")
    expect(evaluatePolicy({ calls: 0, metrics, mode: "warn", pauseArmed: true }).state).toBe("PRESSURE")

    // Handoff needs pressure AND a pause; either alone is not enough.
    expect(evaluatePolicy({ calls: 0, metrics, mode: "handoff", pauseArmed: false }).state).toBe("PRESSURE")
    expect(evaluatePolicy({ calls: 500, metrics: [], mode: "handoff", pauseArmed: true }).state).toBe("ATTENTION")
    expect(evaluatePolicy({ calls: 0, metrics, mode: "handoff", pauseArmed: true }).state).toBe("HANDOFF_RECOMMENDED")

    // Block acts on the hard limit only -- pressure alone never strands a session.
    expect(evaluatePolicy({ calls: 0, metrics, mode: "block", pauseArmed: false }).state).toBe("BLOCKED")
    expect(evaluatePolicy({ calls: 0, metrics: [contextMetric(WARN_AT + 1)], mode: "block", pauseArmed: false }).state)
      .toBe("PRESSURE")
  })

  it("emits nothing without a section, and one header with any", () => {
    const verdict = evaluatePolicy({ calls: 500, metrics: [], mode: "warn", pauseArmed: false })
    expect(renderPolicy(verdict, 500, {})).toBeUndefined()
    // An empty section is not a section: a bare header is noise.
    expect(renderPolicy(verdict, 500, { announce: [] })).toBeUndefined()

    const lines = renderPolicy(verdict, 500, { announce: ["a"], audit: ["b"] })
    expect(lines?.filter((l) => l.startsWith("TOKEN NORM -- ATTENTION"))).toHaveLength(1)
    // Fixed order regardless of which sections are present.
    expect(lines?.indexOf("a")).toBeLessThan(lines?.indexOf("b") ?? -1)
  })

  // The cases above are worked examples: they show the machine doing the right
  // thing on inputs a human chose. These are the properties those examples are
  // instances OF, checked over the whole reachable input space, so a future
  // threshold added as an axis cannot quietly break one of them on a
  // combination nobody thought to write down.
  describe("properties over the whole input space", () => {
    const MODES: BudgetMode[] = ["observe", "warn", "handoff", "block"]

    /** Every interesting combination: both sides of each threshold, both pause
     * states, every mode, plus the no-metrics case (window unresolvable). */
    function* inputs(): Generator<PolicyInput> {
      const callCounts = [0, ANNOUNCE_AT - 1, ANNOUNCE_AT, ANNOUNCE_AT + 50]
      const metricSets: BudgetMetric[][] = [
        [],
        [contextMetric(0)],
        [contextMetric(WARN_AT - 1)],
        [contextMetric(WARN_AT)],
        [contextMetric(CONTEXT_LIMIT)],
        [callsMetric(0, 10)],
        [callsMetric(9, 10)],
        [callsMetric(10, 10)],
        [callsMetric(10, 10), contextMetric(CONTEXT_LIMIT)],
        [callsMetric(0, 10), contextMetric(WARN_AT)],
      ]
      for (const calls of callCounts) {
        for (const metrics of metricSets) {
          for (const mode of MODES) {
            for (const pauseArmed of [false, true]) {
              yield { calls, metrics, mode, pauseArmed }
            }
          }
        }
      }
    }

    const ALL = [...inputs()]

    // Nothing in the machine may depend on a clock, a counter, or a previous
    // call. This is what lets the status tool evaluate without latching: asking
    // where the session stands cannot change where it stands.
    it("is idempotent -- the same input always yields the same verdict", () => {
      for (const input of ALL) {
        const a = evaluatePolicy(input)
        const b = evaluatePolicy(input)
        expect(b.state).toBe(a.state)
        expect(b.base).toBe(a.base)
        expect(b.exceeded).toBe(a.exceeded)
        expect(b.driver.name).toBe(a.driver.name)
        expect(b.driver.detail).toBe(a.driver.detail)
      }
    })

    it("BLOCKED requires block mode AND a hard limit exceeded, and block mode with one always blocks", () => {
      for (const input of ALL) {
        const v = evaluatePolicy(input)
        if (v.state === "BLOCKED") {
          expect(input.mode).toBe("block")
          expect(v.exceeded).toBe(true)
        }
        if (input.mode === "block" && v.exceeded) expect(v.state).toBe("BLOCKED")
        // No other mode can ever produce it, whatever the numbers say.
        if (input.mode !== "block") expect(v.state).not.toBe("BLOCKED")
      }
    })

    it("HANDOFF_RECOMMENDED requires handoff mode AND pressure AND an armed pause", () => {
      for (const input of ALL) {
        const v = evaluatePolicy(input)
        if (v.state === "HANDOFF_RECOMMENDED") {
          expect(input.mode).toBe("handoff")
          expect(input.pauseArmed).toBe(true)
          expect(ordinal(v.base)).toBeGreaterThanOrEqual(ordinal("PRESSURE"))
        }
        // And the converse: those three together always produce it, so a
        // pause can never be silently swallowed.
        if (input.mode === "handoff" && input.pauseArmed && ordinal(v.base) >= ordinal("PRESSURE")) {
          expect(v.state).toBe("HANDOFF_RECOMMENDED")
        }
      }
    })

    // Observe mode's whole contract: it measures exactly what warn measures.
    // If this drifts, the status tool starts lying in the safest mode.
    it("measures identically in observe and warn mode", () => {
      for (const input of ALL) {
        const observed = evaluatePolicy({ ...input, mode: "observe" })
        const warned = evaluatePolicy({ ...input, mode: "warn" })
        expect(observed.state).toBe(warned.state)
        expect(observed.base).toBe(warned.base)
      }
    })

    it("never reports a state below the max of its axes, and the driver is a real axis at that level", () => {
      for (const input of ALL) {
        const v = evaluatePolicy(input)
        const axisMax = maxState(maxState(v.axes.calls.state, v.axes.budget.state), v.axes.context.state)
        expect(v.base).toBe(axisMax)
        // The mode may lift the state; it may never lower it.
        expect(ordinal(v.state)).toBeGreaterThanOrEqual(ordinal(v.base))
        expect(["calls", "budget", "context"]).toContain(v.driver.name)
        if (v.base !== "HEALTHY") expect(v.axes[v.driver.name].state).toBe(v.base)
      }
    })

    // The failure this whole module was written to stop: three thresholds
    // landing on one tool call and stapling three reminder blocks onto it.
    it("renders at most one block, with exactly one header, whatever is due", () => {
      const every: PolicySections = {
        boundary: ["B"],
        announce: ["A"],
        audit: ["U"],
        budget: ["G"],
        handoff: ["H"],
      }
      const keys = Object.keys(every) as Array<keyof PolicySections>
      for (const input of ALL) {
        const v = evaluatePolicy(input)
        // Every subset of sections, including all five at once.
        for (let mask = 0; mask < 1 << keys.length; mask++) {
          const sections: PolicySections = {}
          keys.forEach((key, bit) => {
            if (mask & (1 << bit)) sections[key] = every[key]
          })
          const lines = renderPolicy(v, input.calls, sections)
          if (mask === 0) {
            expect(lines).toBeUndefined()
            continue
          }
          const headers = (lines ?? []).filter((l) => l.startsWith("TOKEN NORM -- "))
          expect(headers).toHaveLength(1)
          expect(headers[0]).toContain(v.state)
          // Fixed order, never interleaved: boundary, announce, audit, budget, handoff.
          const present = ["B", "A", "U", "G", "H"].filter((t) => lines?.includes(t))
          const positions = present.map((t) => lines?.indexOf(t) ?? -1)
          expect(positions).toEqual([...positions].sort((a, b) => a - b))
        }
      }
    })

    // The status tool's contract, checked against the machine that feeds it.
    it("always snapshots peak at or above current, with a recommendation drawn from peak", () => {
      let peak: PolicyState = "HEALTHY"
      for (const input of ALL) {
        const v = evaluatePolicy(input)
        peak = maxState(peak, v.state)
        const snap = snapshotFrom({
          toolCalls: input.calls,
          context: 0,
          cost: { used: 0 },
          effectiveTokens: { used: 0 },
          current: v.state,
          peak,
          driver: v.driver.name,
        })
        expect(ordinal(snap.policy.peak)).toBeGreaterThanOrEqual(ordinal(snap.policy.current))
        expect(snap.state).toBe(snap.policy.peak)
        expect(snap.recommendation).toBe(recommendationFor(snap.policy.peak))
      }
      // The sweep reaches the top of the ladder, so the assertions above were
      // not all made on HEALTHY.
      expect(peak).toBe("BLOCKED")
    })
  })
})
