import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))

const REQUIRED_ENTRIES = [
  "LICENSE",
  "README.md",
  "package.json",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/plugin.js",
  "dist/claude-hook.mjs",
  "dist/provenance.json",
  "scripts/install-local.mjs",
  "scripts/usage-audit.py",
]

const PROVENANCE_ARTIFACTS = ["dist/plugin.js", "dist/claude-hook.mjs", "scripts/usage-audit.py"]

const ROOT_ENTRIES = new Set(["LICENSE", "README.md", "package.json"])

const tempRoots: string[] = []
let tarballFiles: string[] = []
let packedPackageDir = ""

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

// npm on Windows is a .cmd shim, which child_process can only run through a
// shell. Prefer npm_execpath (npm sets it for lifecycle scripts) so the npm CLI
// is started as plain Node and no path ever needs shell quoting.
function runNpm(args: string[]): string {
  const npmCli = process.env.npm_execpath
  if (npmCli && fs.existsSync(npmCli)) {
    return execFileSync(process.execPath, [npmCli, ...args], { cwd: repoRoot, encoding: "utf8" })
  }
  return execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  })
}

function listFiles(dir: string, prefix = ""): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), relative) : [relative]
  })
}

describe("packaged artifact", () => {
  beforeAll(() => {
    // npm publish runs prepublishOnly (build + build:plugin) before packing, so
    // reproduce that here instead of asserting on a partially built dist/.
    runNpm(["run", "build"])
    if (!fs.existsSync(path.join(repoRoot, "dist", "plugin.js"))) runNpm(["run", "build:plugin"])

    const packDir = tempDir("token-norm-pack-")
    const parsed = JSON.parse(runNpm(["pack", "--json", "--pack-destination", packDir])) as
      | Array<{ filename: string; files: Array<{ path: string }> }>
      | Record<string, { filename: string; files: Array<{ path: string }> }>
    const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
    tarballFiles = entry.files.map((file) => file.path)

    packedPackageDir = tempDir("token-norm-unpack-")
    execFileSync("tar", ["-xzf", path.join(packDir, entry.filename), "-C", packedPackageDir])
  }, 120_000)

  afterAll(() => {
    for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true })
  })

  it("ships the plugin bundle, entry points, installer, audit script and docs", () => {
    for (const required of REQUIRED_ENTRIES) expect(tarballFiles).toContain(required)
  })

  it("ships every build output and nothing else", () => {
    const builtDist = listFiles(path.join(repoRoot, "dist")).map((file) => `dist/${file}`)
    expect(tarballFiles.filter((file) => file.startsWith("dist/")).sort()).toEqual(builtDist.sort())

    expect(tarballFiles.filter((file) => file.startsWith("scripts/")).sort()).toEqual([
      "scripts/install-local.mjs",
      "scripts/usage-audit.py",
    ])

    const unexpected = tarballFiles.filter(
      (file) => !ROOT_ENTRIES.has(file) && !file.startsWith("dist/") && !file.startsWith("scripts/"),
    )
    expect(unexpected).toEqual([])
  })

  // The three hashed files leave npm's integrity story the moment the installer
  // copies them into ~/.config/opencode. If the recorded digests do not match
  // the bytes actually packed, the published provenance is worse than none.
  it("records the commit and the true sha256 of every artifact it names", () => {
    const packageRoot = path.join(packedPackageDir, "package")
    const provenance = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "dist", "provenance.json"), "utf8"),
    ) as {
      name: string
      version: string
      gitSha: string
      algorithm: string
      artifacts: Record<string, string>
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      name: string
      version: string
    }
    expect(provenance.name).toBe(pkg.name)
    expect(provenance.version).toBe(pkg.version)
    expect(provenance.algorithm).toBe("sha256")
    expect(provenance.gitSha).toMatch(/^[0-9a-f]{40}$/)

    expect(Object.keys(provenance.artifacts).sort()).toEqual([...PROVENANCE_ARTIFACTS].sort())
    for (const [relative, digest] of Object.entries(provenance.artifacts)) {
      const packed = fs.readFileSync(path.join(packageRoot, relative))
      expect(createHash("sha256").update(packed).digest("hex"), `${relative} digest`).toBe(digest)
    }
  })

  it("installs both files from the tarball, idempotently, replacing stale copies", () => {
    const configHome = tempDir("token-norm-xdg-")
    const fakeHome = tempDir("token-norm-home-")
    const env = { ...process.env, XDG_CONFIG_HOME: configHome, HOME: fakeHome, USERPROFILE: fakeHome }

    const packageRoot = path.join(packedPackageDir, "package")
    const installer = path.join(packageRoot, "scripts", "install-local.mjs")
    const packedPlugin = path.join(packageRoot, "dist", "plugin.js")
    const packedAudit = path.join(packageRoot, "scripts", "usage-audit.py")
    const pluginTarget = path.join(configHome, "opencode", "plugins", "opencode-token-norm.js")
    const auditTarget = path.join(configHome, "opencode", "scripts", "usage-audit.py")

    execFileSync(process.execPath, [installer], { env, encoding: "utf8" })
    expect(fs.readFileSync(pluginTarget)).toEqual(fs.readFileSync(packedPlugin))
    expect(fs.readFileSync(auditTarget)).toEqual(fs.readFileSync(packedAudit))

    const installedPlugin = fs.readFileSync(pluginTarget)
    const installedAudit = fs.readFileSync(auditTarget)
    execFileSync(process.execPath, [installer], { env, encoding: "utf8" })
    expect(fs.readFileSync(pluginTarget)).toEqual(installedPlugin)
    expect(fs.readFileSync(auditTarget)).toEqual(installedAudit)

    fs.writeFileSync(auditTarget, "# stale audit script\n")
    execFileSync(process.execPath, [installer], { env, encoding: "utf8" })
    expect(fs.readFileSync(auditTarget)).toEqual(installedAudit)
  }, 30_000)
})
