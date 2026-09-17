import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

const script = fileURLToPath(new URL("../scripts/install-local.mjs", import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), "token-norm-install-"))
const env = { ...process.env, XDG_CONFIG_HOME: home }

const plugin = path.join(home, "opencode", "plugins", "opencode-token-norm.js")
const audit = path.join(home, "opencode", "scripts", "usage-audit.py")

/** Runs the CLI and returns stdout plus the exit code, because `doctor` uses
 * the exit code as its verdict and execFileSync throws on a non-zero one. */
function run(args: string[], extraEnv: Record<string, string> = {}): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      stdio: "pipe",
    })
    return { out, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 }
  }
}

describe("install-local CLI", () => {
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

  it("installs a self-contained bundle and the audit script", () => {
    const { out } = run([])
    expect(out).toContain("installed plugin")

    const source = fs.readFileSync(plugin, "utf8")
    expect(source).toContain("TokenNormBudget")
    expect(source).not.toMatch(/from\s*"@opencode-ai\//)
    expect(fs.existsSync(audit)).toBe(true)
  })

  it("uninstalls both files", () => {
    const { out } = run(["uninstall"])
    expect(out).toContain("removed")
    expect(fs.existsSync(plugin)).toBe(false)
    expect(fs.existsSync(audit)).toBe(false)
  })

  it("rejects an unknown command", () => {
    expect(run(["nonsense"]).code).not.toBe(0)
  })
})

describe("install-local --dry-run", () => {
  beforeEach(() => fs.rmSync(path.join(home, "opencode"), { recursive: true, force: true }))
  afterAll(() => fs.rmSync(path.join(home, "opencode"), { recursive: true, force: true }))

  it("names every target path and writes nothing", () => {
    const { out, code } = run(["--dry-run"])
    expect(code).toBe(0)
    expect(out).toContain(plugin)
    expect(out).toContain(audit)
    expect(out).toContain("nothing was written")
    // The trust claim is the point of the preview, so it is asserted, not just printed.
    expect(out).toContain(`No files outside ${path.join(home, "opencode")}`)
    expect(fs.existsSync(plugin)).toBe(false)
    expect(fs.existsSync(audit)).toBe(false)
  })

  it("distinguishes create from overwrite", () => {
    expect(run(["--dry-run"]).out).toContain("create")
    run([])
    expect(run(["--dry-run"]).out).toContain("overwrite")
  })

  it("previews an uninstall without removing anything", () => {
    run([])
    const { out } = run(["uninstall", "--dry-run"])
    expect(out).toContain("nothing was removed")
    expect(fs.existsSync(plugin)).toBe(true)
  })
})

describe("install-local doctor", () => {
  beforeEach(() => fs.rmSync(path.join(home, "opencode"), { recursive: true, force: true }))
  afterAll(() => fs.rmSync(path.join(home, "opencode"), { recursive: true, force: true }))

  it("fails when the plugin is not installed", () => {
    const { out, code } = run(["doctor"])
    expect(code).toBe(1)
    expect(out).toContain("Status: not working")
    expect(out).toMatch(/plugin installed\s+not found/)
  })

  it("passes on a fresh install and confirms the installed bytes match the package", () => {
    run([])
    const { out, code } = run(["doctor"])
    expect(code).toBe(0)
    expect(out).toContain("Status: ready")
    expect(out).toContain("matches this package")
  })

  it("warns when the installed plugin is stale, without failing", () => {
    run([])
    fs.appendFileSync(plugin, "\n// drifted\n")
    const { out, code } = run(["doctor"])
    // A stale copy still loads, so this is a warning: a non-zero exit must mean
    // "broken", not "out of date".
    expect(code).toBe(0)
    expect(out).toContain("differs from this package")
    expect(out).toContain("Status: ready (1 warnings)")
  })

  it("warns but does not fail when python3 is missing", () => {
    run([])
    const { out, code } = run(["doctor"], { TOKEN_NORM_PYTHON: "definitely-missing-python" })
    expect(code).toBe(0)
    expect(out).toMatch(/python3\s+definitely-missing-python not runnable/)
  })

  it("reports the same config diagnostics the plugin would apply", () => {
    run([])
    const { out, code } = run(["doctor"], { TOKEN_NORM_MODE: "nonsense", TOKEN_NORM_NOT_A_SETTING: "1" })
    expect(code).toBe(0)
    expect(out).toContain('TOKEN_NORM_MODE="nonsense"')
    expect(out).toContain("using handoff")
    expect(out).toContain("unknown setting")
  })

  it("reports the effective thresholds when settings are valid", () => {
    run([])
    const { out } = run(["doctor"], { TOKEN_NORM_BOUNDARY_AT: "12" })
    expect(out).toContain("boundary@12")
  })

  it("warns when the audit script is absent", () => {
    run([])
    fs.rmSync(audit)
    const { out, code } = run(["doctor"])
    expect(code).toBe(0)
    expect(out).toMatch(/audit script\s+not found/)
  })

  it("warns when opencode config still registers the plugin twice", () => {
    run([])
    fs.writeFileSync(
      path.join(home, "opencode", "opencode.json"),
      JSON.stringify({ plugin: ["opencode-token-norm"] }),
    )
    const { out } = run(["doctor"])
    expect(out).toContain('still lists "opencode-token-norm"')
    fs.rmSync(path.join(home, "opencode", "opencode.json"))
  })

  it("lists doctor and --dry-run in help", () => {
    const { out } = run(["help"])
    expect(out).toContain("doctor")
    expect(out).toContain("--dry-run")
  })
})
