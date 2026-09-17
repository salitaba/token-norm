import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }))

import { execFileSync } from "node:child_process"
import { runAudit } from "../src/core/audit.js"

const exec = vi.mocked(execFileSync)

describe("runAudit", () => {
  beforeEach(() => {
    exec.mockReset()
  })

  it("keeps only the lines that change a decision", () => {
    exec.mockReturnValue(
      [
        "SESSION RECEIPT",
        "totals  : input 23k  output 15k  cache_read 891k  cache_write 87k",
        "effective fresh tokens: 221k",
        "calls   : 22   context/call min 23k med 49k max 61k",
        "cacheR  : per-call med 45k",
        "cache   : 23x cache read ÷ (input+output) — bloat driver ok",
        "verdict  watch — context creeping past 60k",
      ].join("\n"),
    )
    const out = runAudit("ses_x")
    expect(out).toContain("totals")
    expect(out).toContain("effective fresh tokens: 221k")
    expect(out).toContain("cacheR")
    expect(out).not.toContain("verdict")
    expect(out).not.toContain("SESSION RECEIPT")
    const args = exec.mock.calls[0][1] as string[]
    expect(args).toContain("--session")
    expect(args).toContain("ses_x")
  })

  it("falls back to raw output when nothing matches, and uses --last without a session", () => {
    exec.mockReturnValue("no decision lines here")
    expect(runAudit()).toBe("no decision lines here")
    expect(exec.mock.calls[0][1]).toContain("--last")
  })

  it("never throws: explains the failure and how to run it by hand", () => {
    exec.mockImplementation(() => {
      throw new Error("spawn python3 ENOENT")
    })
    const out = runAudit("ses_dead")
    expect(out).toContain("usage-audit did not run")
    expect(out).toContain("spawn python3 ENOENT")
    expect(out).toContain("--session ses_dead")
  })
})
