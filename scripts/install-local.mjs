#!/usr/bin/env node
// One-command installer for the opencode-token-norm OpenCode plugin.
//
// Why it installs a local plugin file instead of the npm-spec `plugin` entry:
// OpenCode builds >= 1.17 can silently never initialize npm-spec plugins (no
// error, no log, no tool; upstream anomalyco/opencode#48379). The identical code
// loaded from a local plugin file works. So the published package ships a
// self-contained bundle (all dependencies inlined) and this command copies it
// into the global plugin directory.
//
//   npx opencode-token-norm            install / update
//   npx opencode-token-norm --dry-run  show exactly what install would write
//   npx opencode-token-norm doctor     check an existing install
//   npx opencode-token-norm uninstall  remove
//
// `doctor` and `--dry-run` exist because this command writes files into a
// directory the user did not choose, from a `npx` invocation they cannot read
// first. Both are read-only: they name every path before anything is written,
// and afterwards answer "is the plugin I am running the one this package
// ships?" -- a question a copied loose file cannot otherwise answer.
import { execFileSync } from "node:child_process"
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const bundle = join(pkgRoot, "dist", "plugin.js")
const auditScript = join(pkgRoot, "scripts", "usage-audit.py")
const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
const opencodeDir = join(configHome, "opencode")
const pluginTarget = join(opencodeDir, "plugins", "opencode-token-norm.js")
const auditTarget = join(opencodeDir, "scripts", "usage-audit.py")

const argv = process.argv.slice(2)
const dryRun = argv.includes("--dry-run")
const command = (argv.find((a) => !a.startsWith("--")) ?? "install").replace(/^--/, "")

function configStillListsPlugin() {
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const file = join(opencodeDir, name)
    if (!existsSync(file)) continue
    try {
      if (/"plugin"\s*:\s*\[[^\]]*"opencode-token-norm"/.test(readFileSync(file, "utf8"))) return name
    } catch {
      /* unreadable config is not this command's problem */
    }
  }
  return null
}

/** Every write this command performs, named before it happens. The plan is the
 * single source of truth for both `--dry-run` and the install itself, so the
 * preview can never drift from what is actually copied. */
function plan() {
  return [
    { what: "plugin", from: bundle, to: pluginTarget },
    { what: "audit script", from: auditScript, to: auditTarget },
  ]
}

function printPlan() {
  console.log("Token Norm install plan\n")
  for (const step of plan()) {
    console.log(`  ${step.what.padEnd(12)} ${existsSync(step.to) ? "overwrite" : "create"}  ${step.to}`)
  }
  console.log("")
  console.log(`No files outside ${opencodeDir} are created, modified, or removed.`)
  console.log("Nothing is added to your shell profile, PATH, or opencode config.")
}

function install() {
  if (!existsSync(bundle)) {
    console.error(`no build found at ${bundle}\nrun \`npm run build:plugin\` first, or install from npm`)
    process.exit(1)
  }
  if (dryRun) {
    printPlan()
    console.log("\n--dry-run: nothing was written.")
    return
  }
  mkdirSync(dirname(pluginTarget), { recursive: true })
  mkdirSync(dirname(auditTarget), { recursive: true })
  copyFileSync(bundle, pluginTarget)
  copyFileSync(auditScript, auditTarget)

  console.log(`installed plugin  -> ${pluginTarget}`)
  console.log(`installed audit   -> ${auditTarget}`)
  console.log("")
  console.log("Restart OpenCode to load it, then check it with:")
  console.log("  npx opencode-token-norm doctor")
  const listed = configStillListsPlugin()
  if (listed) {
    console.log("")
    console.log(`note: ${listed} still lists "opencode-token-norm" under "plugin".`)
    console.log("Remove that entry so a future fixed OpenCode does not load it twice.")
  }
}

function uninstall() {
  if (dryRun) {
    console.log("Token Norm uninstall plan\n")
    for (const file of [pluginTarget, auditTarget]) {
      console.log(`  ${existsSync(file) ? "remove " : "absent "} ${file}`)
    }
    console.log("\n--dry-run: nothing was removed.")
    return
  }
  let removed = false
  for (const file of [pluginTarget, auditTarget]) {
    if (existsSync(file)) {
      rmSync(file)
      console.log(`removed ${file}`)
      removed = true
    }
  }
  if (!removed) console.log("nothing to remove")
}

// --- doctor ------------------------------------------------------------------
//
// A check reports one of three verdicts. `fail` is reserved for states that
// mean the plugin is not working; anything the user may have chosen on purpose
// (no python3, no opencode on PATH) is a `warn`, because doctor exiting
// non-zero should mean "this is broken", not "this is unusual".

const results = []
const ok = (label, detail) => results.push({ level: "ok", label, detail })
const warn = (label, detail) => results.push({ level: "warn", label, detail })
const fail = (label, detail) => results.push({ level: "fail", label, detail })

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function readPkgVersion() {
  try {
    return JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version ?? "unknown"
  } catch {
    return "unknown"
  }
}

function checkNode() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10)
  if (major >= 22) ok("node", process.versions.node)
  else fail("node", `${process.versions.node} -- Token Norm needs >= 22`)
}

function checkPackage() {
  if (existsSync(bundle)) ok("package bundle", `${readPkgVersion()} at ${bundle}`)
  else fail("package bundle", `missing ${bundle} -- run \`npm run build:plugin\``)
}

/** The check that a loose copied file cannot otherwise answer: is the installed
 * plugin the one this package ships, or a stale copy from an older version? */
function checkInstalled() {
  if (!existsSync(pluginTarget)) {
    fail("plugin installed", `not found at ${pluginTarget} -- run \`npx opencode-token-norm\``)
    return
  }
  if (!existsSync(bundle)) {
    warn("plugin installed", `${pluginTarget} (cannot compare: no bundle in this package)`)
    return
  }
  if (sha256(pluginTarget) === sha256(bundle)) ok("plugin installed", `${pluginTarget} (matches this package)`)
  else warn("plugin installed", `${pluginTarget} differs from this package -- rerun \`npx opencode-token-norm\` to update`)
}

function checkAuditScript() {
  if (!existsSync(auditTarget)) {
    warn("audit script", `not found at ${auditTarget} -- the 60-call audit checkpoint will report that it did not run`)
    return
  }
  try {
    accessSync(auditTarget, constants.R_OK)
    ok("audit script", auditTarget)
  } catch {
    warn("audit script", `${auditTarget} is not readable`)
  }
}

function checkPython() {
  const python = process.env.TOKEN_NORM_PYTHON || "python3"
  try {
    const out = execFileSync(python, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    })
    ok("python3", out.trim())
  } catch {
    warn("python3", `${python} not runnable -- audits are skipped, everything else still works`)
  }
}

function checkDatabase() {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  const db = process.env.OPENCODE_DB || join(dataHome, "opencode", "opencode.db")
  if (!existsSync(db)) {
    warn("opencode db", `not found at ${db} -- audits have nothing to read yet`)
    return
  }
  try {
    accessSync(db, constants.R_OK)
    ok("opencode db", `${db} (read-only access)`)
  } catch {
    warn("opencode db", `${db} exists but is not readable`)
  }
}

function checkOpencode() {
  try {
    const out = execFileSync("opencode", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    })
    ok("opencode", out.trim())
  } catch {
    warn("opencode", "not on PATH -- cannot verify the host build")
  }
}

function checkDuplicateRegistration() {
  const listed = configStillListsPlugin()
  if (listed) warn("config", `${listed} still lists "opencode-token-norm" under "plugin" -- remove that entry`)
  else ok("config", "no duplicate plugin registration")
}

/** Reuses the plugin's own parser rather than a second copy of the key list,
 * so doctor cannot disagree with what the plugin will actually do. Skipped
 * when the tsc build is absent (a fresh checkout that only ran build:plugin). */
async function checkSettings() {
  // dist/config.js is where the pre-0.12 layout put it; dist/core/config.js is
  // where it lives now. Both are accepted so doctor keeps working against an
  // older installed package instead of reporting a silent "not checked".
  const config = [join(pkgRoot, "dist", "core", "config.js"), join(pkgRoot, "dist", "config.js")].find(existsSync)
  if (!config) {
    warn("settings", "not checked (no compiled config.js in this package)")
    return
  }
  try {
    const mod = await import(`file://${config}`)
    const diagnostics = mod.takeConfigDiagnostics()
    if (diagnostics.length === 0) {
      ok("settings", `mode=${mod.MODE}, announce@${mod.ANNOUNCE_AT} boundary@${mod.BOUNDARY_AT} audit@${mod.AUDIT_EVERY}`)
      return
    }
    for (const d of diagnostics) warn("settings", `${d.name}="${d.raw}" ${d.reason}; using ${d.using}`)
  } catch (err) {
    warn("settings", `could not be read: ${String(err instanceof Error ? err.message : err).slice(0, 80)}`)
  }
}

const MARK = { ok: "\u2713", warn: "!", fail: "\u2717" }

async function doctor() {
  checkNode()
  checkOpencode()
  checkPackage()
  checkInstalled()
  checkAuditScript()
  await checkSettings()
  checkPython()
  checkDatabase()
  checkDuplicateRegistration()

  console.log("Token Norm doctor\n")
  for (const r of results) console.log(`  ${MARK[r.level]} ${r.label.padEnd(17)} ${r.detail}`)

  const failed = results.filter((r) => r.level === "fail").length
  const warned = results.filter((r) => r.level === "warn").length
  console.log("")
  if (failed > 0) {
    console.log(`Status: not working (${failed} failed, ${warned} warnings)`)
    process.exit(1)
  }
  console.log(warned > 0 ? `Status: ready (${warned} warnings)` : "Status: ready")
}

function help() {
  console.log("usage: opencode-token-norm [install|doctor|uninstall] [--dry-run]\n")
  console.log("  install    copy the plugin into ~/.config/opencode/plugins (default)")
  console.log("  doctor     check the install and report what would break")
  console.log("  uninstall  remove it")
  console.log("")
  console.log("  --dry-run  print every path install/uninstall would touch, write nothing")
}

if (command === "install") install()
else if (command === "uninstall" || command === "remove") uninstall()
else if (command === "doctor") await doctor()
else if (command === "help") help()
else {
  help()
  process.exit(1)
}
