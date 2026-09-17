import { beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// A setting that is present but unusable falls back to the default. Silently,
// before this: the user believes a budget is configured and no budget is in
// force. These tests pin the report, not the fallback -- the fallbacks are
// already covered in session-budget.test.ts.

const LOG_DIR = mkdtempSync(join(tmpdir(), "token-norm-cfg-"))

const TOUCHED = [
  "TOKEN_NORM_MODE",
  "TOKEN_NORM_ANNOUNCE_AT",
  "TOKEN_NORM_AUDIT_EVERY",
  "TOKEN_NORM_BOUNDARY_AT",
  "TOKEN_NORM_MAX_COST",
  "TOKEN_NORM_MAX_TOOL_CALLS",
  "TOKEN_NORM_MAX_EFFECTIVE_TOKENS",
  "TOKEN_NORM_CONTEXT_WARN",
  "TOKEN_NORM_CONTEXT_LIMIT",
  "TOKEN_NORM_CHEAP_TOOLS",
  "TOKEN_NORM_TOOL_WEIGHTS",
  "TOKEN_NORM_PHASE_WEIGHTS",
  "TOKEN_NORM_BUDGET",
  "TOKEN_NORM_HANDOFF",
  "TOKEN_NORM_SETTLE_MS",
  "TOKEN_NORM_SWITCH_WAIT_MS",
  "TOKEN_NORM_TYPOED_KEY",
]

/** Reloads config.ts under a given environment. Module state is per-load, so
 * the diagnostics queue is built fresh each time. */
async function freshConfig(env: Record<string, string> = {}): Promise<any> {
  vi.resetModules()
  for (const key of TOUCHED) delete process.env[key]
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  return import("../src/core/config.js")
}

async function diagnose(env: Record<string, string>): Promise<any[]> {
  const cfg = await freshConfig(env)
  return cfg.takeConfigDiagnostics()
}

function names(diags: any[]): string[] {
  return diags.map((d) => d.name)
}

beforeEach(() => {
  process.env.TOKEN_NORM_LOG = join(LOG_DIR, `${Math.random().toString(36).slice(2)}.log`)
})

describe("config diagnostics", () => {
  it("reports nothing when no TOKEN_NORM_* settings are present", async () => {
    expect(await diagnose({})).toEqual([])
  })

  it("reports nothing for well-formed settings", async () => {
    const cfg = await freshConfig({
      TOKEN_NORM_MODE: "block",
      TOKEN_NORM_ANNOUNCE_AT: "10",
      TOKEN_NORM_MAX_COST: "0.5",
      TOKEN_NORM_CONTEXT_WARN: "0.9",
      TOKEN_NORM_BUDGET: "0",
      TOKEN_NORM_CHEAP_TOOLS: "read, grep",
    })
    expect(cfg.takeConfigDiagnostics()).toEqual([])
    expect(cfg.MODE).toBe("block")
    expect(cfg.BUDGET_ENABLED).toBe(false)
    expect([...cfg.CHEAP_TOOLS]).toEqual(["read", "grep"])
  })

  it("reports an unknown mode and names the accepted values", async () => {
    const [d, ...rest] = await diagnose({ TOKEN_NORM_MODE: "nonsense" })
    expect(rest).toEqual([])
    expect(d).toMatchObject({ name: "TOKEN_NORM_MODE", raw: "nonsense", using: "warn" })
    expect(d.reason).toContain("observe, warn, handoff, block")
  })

  it("reports a non-integer threshold and the default it fell back to", async () => {
    const [d] = await diagnose({ TOKEN_NORM_ANNOUNCE_AT: "twenty" })
    expect(d).toMatchObject({
      name: "TOKEN_NORM_ANNOUNCE_AT",
      raw: "twenty",
      reason: "expected a positive integer",
      using: "25",
    })
  })

  it("reports a zero or negative budget as no limit, not as a zero limit", async () => {
    const diags = await diagnose({ TOKEN_NORM_MAX_TOOL_CALLS: "0", TOKEN_NORM_MAX_COST: "-3" })
    expect(names(diags).sort()).toEqual(["TOKEN_NORM_MAX_COST", "TOKEN_NORM_MAX_TOOL_CALLS"])
    expect(diags.every((d) => d.using === "no limit")).toBe(true)
    expect(diags.every((d) => d.reason === "expected a positive number")).toBe(true)
  })

  it("reports an out-of-range context fraction", async () => {
    const [d] = await diagnose({ TOKEN_NORM_CONTEXT_WARN: "80" })
    expect(d).toMatchObject({ name: "TOKEN_NORM_CONTEXT_WARN", raw: "80", using: "0.8" })
    expect(d.reason).toContain("between 0 and 1")
  })

  it('reports a kill switch that is neither "0" nor "1" instead of leaving it on in silence', async () => {
    const cfg = await freshConfig({ TOKEN_NORM_BUDGET: "false" })
    const [d] = cfg.takeConfigDiagnostics()
    expect(d).toMatchObject({ name: "TOKEN_NORM_BUDGET", raw: "false", using: "1" })
    // The fallback is still "enabled": a typo must not disable enforcement.
    expect(cfg.BUDGET_ENABLED).toBe(true)
  })

  it("reports an empty cheap-tool list, which would make every tool billable", async () => {
    const cfg = await freshConfig({ TOKEN_NORM_CHEAP_TOOLS: " , ," })
    const [d] = cfg.takeConfigDiagnostics()
    expect(d).toMatchObject({ name: "TOKEN_NORM_CHEAP_TOOLS", using: "todowrite,question,skill" })
    expect([...cfg.CHEAP_TOOLS]).toEqual(["todowrite", "question", "skill"])
  })

  it("reports malformed tool-weight entries and keeps the well-formed ones", async () => {
    const cfg = await freshConfig({ TOKEN_NORM_TOOL_WEIGHTS: "bash=2,read=nope,=3,glob=0" })
    const diags: any[] = cfg.takeConfigDiagnostics()
    expect(diags).toHaveLength(3)
    expect(diags.every((d) => d.name === "TOKEN_NORM_TOOL_WEIGHTS" && d.using === "weight 1")).toBe(true)
    expect([...cfg.TOOL_WEIGHTS]).toEqual([["bash", 2]])
  })

  it("reports a malformed phase weight while keeping the parsed pair", async () => {
    const cfg = await freshConfig({ TOKEN_NORM_PHASE_WEIGHTS: "plan=0.5,build" })
    const [d] = cfg.takeConfigDiagnostics()
    expect(d).toMatchObject({ name: "TOKEN_NORM_PHASE_WEIGHTS", raw: "build", using: "weight 1" })
    expect([...cfg.PHASE_WEIGHTS]).toEqual([["plan", 0.5]])
  })

  it("reports an unknown TOKEN_NORM_* key as a probable typo", async () => {
    const [d] = await diagnose({ TOKEN_NORM_TYPOED_KEY: "1" })
    expect(d).toMatchObject({ name: "TOKEN_NORM_TYPOED_KEY", using: "ignored" })
    expect(d.reason).toContain("typo")
  })

  it("does not flag settings read outside config.ts as unknown", async () => {
    const cfg = await freshConfig({ TOKEN_NORM_SETTLE_MS: "10", TOKEN_NORM_SWITCH_WAIT_MS: "10" })
    expect(cfg.takeConfigDiagnostics()).toEqual([])
    expect(cfg.SETTLE_MS).toBe(10)
    expect(cfg.SWITCH_WAIT).toBe(10)
  })

  it("collects every problem, not only the first", async () => {
    const diags = await diagnose({
      TOKEN_NORM_MODE: "nope",
      TOKEN_NORM_AUDIT_EVERY: "-1",
      TOKEN_NORM_CONTEXT_WARN: "abc",
    })
    expect(names(diags).sort()).toEqual([
      "TOKEN_NORM_AUDIT_EVERY",
      "TOKEN_NORM_CONTEXT_WARN",
      "TOKEN_NORM_MODE",
    ])
  })

  it("drains, so a second reporter does not repeat the same warnings", async () => {
    const cfg = await freshConfig({ TOKEN_NORM_MODE: "nope" })
    expect(cfg.takeConfigDiagnostics()).toHaveLength(1)
    expect(cfg.takeConfigDiagnostics()).toEqual([])
  })
})

describe("logConfigDiagnostics", () => {
  it("writes one line per problem to the log and returns them", async () => {
    vi.resetModules()
    for (const key of TOUCHED) delete process.env[key]
    process.env.TOKEN_NORM_MODE = "nope"
    const logPath = process.env.TOKEN_NORM_LOG!
    const { logConfigDiagnostics } = await import("../src/core/log.js")

    const lines = logConfigDiagnostics()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('TOKEN_NORM_MODE="nope" ignored')
    expect(lines[0]).toContain("using warn")
    expect(readFileSync(logPath, "utf8")).toContain(lines[0])

    // Drained: a second half of the plugin loading must not re-report.
    expect(logConfigDiagnostics()).toEqual([])
    delete process.env.TOKEN_NORM_MODE
  })

  it("returns nothing and writes nothing when the config is clean", async () => {
    vi.resetModules()
    for (const key of TOUCHED) delete process.env[key]
    const { logConfigDiagnostics } = await import("../src/core/log.js")
    expect(logConfigDiagnostics()).toEqual([])
  })
})
