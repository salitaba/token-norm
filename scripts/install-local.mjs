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
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
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

// Claude Code's hook commands are absolute paths in a config file, so the file
// they name has to outlive the install: `npx` unpacks this package into a cache
// directory that is deleted, which would leave settings.json pointing at
// nothing. Hence a copy into a stable directory, exactly as the OpenCode side
// copies dist/plugin.js instead of registering an npm spec.
//
// CLAUDE_CONFIG_DIR is honoured when set. Claude Code 2.1.274 is not documented
// to read it, but the binary is packed and cannot be grepped for the answer, so
// respecting an explicitly-set value is the option that is wrong in no case.
const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
const claudeBundle = join(pkgRoot, "dist", "claude-hook.mjs")
const claudeHookTarget = join(claudeDir, "token-norm", "hook.mjs")
const claudeSettings = join(claudeDir, "settings.json")

/** The six events the adapter handles, with the matcher convention this host's
 * own settings.json already uses: tool events are scoped with "*", session
 * events carry no matcher. Verified against Claude Code 2.1.274 -- see
 * docs/multi-host-port.md 8d, which also records why Stop injects nothing. */
const CLAUDE_EVENTS = [
  ["PreToolUse", "*"],
  ["PostToolUse", "*"],
  ["PostToolUseFailure", "*"],
  ["UserPromptSubmit", null],
  ["Stop", null],
  ["SessionEnd", null],
  ["SessionStart", null],
]

// The hook is one short-lived node process per event. The timeout is a
// backstop, not a budget: if it ever does hang, the tool call must not hang
// with it.
const CLAUDE_HOOK_TIMEOUT = 10

const argv = process.argv.slice(2)
const dryRun = argv.includes("--dry-run")

/** `--host claude` and `--host=claude` both work, and the value is consumed
 * before the command is read: the subcommand is "the first bare argument", so
 * an unconsumed `claude` would otherwise be taken as the command name. */
function takeHost() {
  const inline = argv.find((a) => a.startsWith("--host="))
  if (inline) return { value: inline.slice("--host=".length), consumed: [inline] }
  const flag = argv.indexOf("--host")
  if (flag === -1) return { value: null, consumed: [] }
  return { value: argv[flag + 1] ?? "", consumed: argv.slice(flag, flag + 2) }
}

const HOSTS = ["opencode", "claude"]
const hostArg = takeHost()
const host = hostArg.value ?? "opencode"
const command = (
  argv.find((a) => !a.startsWith("--") && !hostArg.consumed.includes(a)) ?? "install"
).replace(/^--/, "")

if (!HOSTS.includes(host)) {
  console.error(`unknown host "${host}"\nsupported: ${HOSTS.join(", ")}`)
  process.exit(1)
}

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

// --- claude host -------------------------------------------------------------
//
// settings.json is a file the user owns and third parties already write to: on
// the machine this was developed against it carries rtk and orca hooks across
// ten events. So every function here is additive and identified by our own
// command string -- nothing else in the file is read for meaning, rewritten, or
// reordered, and a file that does not parse is refused rather than replaced.

/** True for a hook entry this installer wrote. Keyed on the installed path
 * rather than the word "token-norm" so a user's unrelated hook that happens to
 * mention the project is never removed by our uninstall. */
function isOurHook(entry) {
  return typeof entry?.command === "string" && entry.command.includes(claudeHookTarget)
}

function claudeHookEntry() {
  // Quoted: the path runs through a shell, and a home directory with a space
  // in it would otherwise split into two arguments.
  return { type: "command", command: `node ${JSON.stringify(claudeHookTarget)}`, timeout: CLAUDE_HOOK_TIMEOUT }
}

/** Reads settings.json for writing. Refuses on anything it cannot round-trip:
 * rewriting a file we did not fully understand is how an installer eats a
 * config it was only meant to add one line to. */
function readSettingsForWrite() {
  if (!existsSync(claudeSettings)) return { settings: {}, existed: false }
  const raw = readFileSync(claudeSettings, "utf8")
  if (raw.trim() === "") return { settings: {}, existed: true }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.error(`${claudeSettings} is not valid JSON:`)
    console.error(`  ${String(err instanceof Error ? err.message : err).slice(0, 120)}`)
    console.error("refusing to write it. Fix or move the file, then run this again.")
    process.exit(1)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`${claudeSettings} is not a JSON object -- refusing to write it`)
    process.exit(1)
  }
  return { settings: parsed, existed: true }
}

function eventGroups(settings, event) {
  const groups = settings?.hooks?.[event]
  return Array.isArray(groups) ? groups : null
}

function eventHasOurHook(settings, event) {
  const groups = eventGroups(settings, event)
  if (!groups) return false
  return groups.some((group) => (Array.isArray(group?.hooks) ? group.hooks : []).some(isOurHook))
}

/** Adds our hook to every event that lacks it and refreshes the entry where it
 * is already present (so a moved install path or changed timeout is corrected
 * rather than duplicated). Returns the events it added, for the report.
 * Mutates `settings`; callers that only want a preview pass a clone. */
function registerClaudeHooks(settings) {
  if (settings.hooks !== undefined && (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks))) {
    console.error(`${claudeSettings} has a "hooks" key that is not an object -- refusing to write it`)
    process.exit(1)
  }
  settings.hooks ??= {}
  const added = []
  for (const [event, matcher] of CLAUDE_EVENTS) {
    const existing = settings.hooks[event]
    if (existing !== undefined && !Array.isArray(existing)) {
      console.error(`${claudeSettings} has a "hooks.${event}" that is not an array -- refusing to write it`)
      process.exit(1)
    }
    const groups = (settings.hooks[event] ??= [])
    let found = false
    for (const group of groups) {
      const hooks = Array.isArray(group?.hooks) ? group.hooks : []
      for (let i = 0; i < hooks.length; i += 1) {
        if (isOurHook(hooks[i])) {
          hooks[i] = claudeHookEntry()
          found = true
        }
      }
    }
    if (found) continue
    groups.push(matcher === null ? { hooks: [claudeHookEntry()] } : { matcher, hooks: [claudeHookEntry()] })
    added.push(event)
  }
  return added
}

/** Removes only our entries, then prunes the containers that our removal left
 * empty -- an empty matcher group or an empty event array is our litter, not
 * the user's configuration. */
function unregisterClaudeHooks(settings) {
  const removed = []
  for (const [event] of CLAUDE_EVENTS) {
    const groups = eventGroups(settings, event)
    if (!groups) continue
    let touched = false
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue
      const kept = group.hooks.filter((entry) => !isOurHook(entry))
      if (kept.length !== group.hooks.length) {
        group.hooks = kept
        touched = true
      }
    }
    const surviving = groups.filter((group) => !(Array.isArray(group?.hooks) && group.hooks.length === 0))
    if (surviving.length !== groups.length) settings.hooks[event] = surviving
    if (settings.hooks[event].length === 0) delete settings.hooks[event]
    if (touched) removed.push(event)
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks
  return removed
}

function writeSettings(settings) {
  // Written to a sibling and renamed: a half-written settings.json would take
  // the host's whole configuration with it, not just our hooks.
  mkdirSync(dirname(claudeSettings), { recursive: true })
  const tmp = `${claudeSettings}.token-norm.tmp`
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`)
  renameSync(tmp, claudeSettings)
}

function printClaudePlan() {
  const { settings, existed } = readSettingsForWrite()
  const added = registerClaudeHooks(structuredClone(settings))
  console.log("Token Norm install plan (host: claude)\n")
  console.log(`  hook         ${existsSync(claudeHookTarget) ? "overwrite" : "create"}  ${claudeHookTarget}`)
  console.log(`  settings     ${existed ? "merge" : "create"}      ${claudeSettings}`)
  for (const [event] of CLAUDE_EVENTS) {
    console.log(`    ${added.includes(event) ? "register          " : "already registered"}  ${event}`)
  }
  console.log("")
  console.log("Only hook entries whose command names the path above are added or refreshed.")
  console.log("Every other hook, matcher, and top-level setting in that file is left alone.")
}

function installClaude() {
  if (!existsSync(claudeBundle)) {
    console.error(`no build found at ${claudeBundle}\nrun \`npm run build:claude-hook\` first, or install from npm`)
    process.exit(1)
  }
  if (dryRun) {
    printClaudePlan()
    console.log("\n--dry-run: nothing was written.")
    return
  }
  mkdirSync(dirname(claudeHookTarget), { recursive: true })
  copyFileSync(claudeBundle, claudeHookTarget)

  const { settings } = readSettingsForWrite()
  const added = registerClaudeHooks(settings)
  writeSettings(settings)

  console.log(`installed hook    -> ${claudeHookTarget}`)
  console.log(
    added.length > 0
      ? `registered        -> ${claudeSettings} (${added.join(", ")})`
      : `already registered in ${claudeSettings}; refreshed the command`,
  )
  console.log("")
  console.log("Restart Claude Code to load it, then check it with:")
  console.log("  npx opencode-token-norm doctor --host claude")
  console.log("")
  // Stated at install time because both are invisible at runtime: a missing
  // axis looks identical to an axis that is fine.
  console.log("On this host the cost axis is inert (the transcript records tokens, not prices),")
  console.log("and the context axis needs TOKEN_NORM_CONTEXT_LIMIT -- nothing in the transcript")
  console.log("gives a window size, and this project does not guess one.")
}

function uninstallClaude() {
  const registered = existsSync(claudeSettings) ? CLAUDE_EVENTS.filter(([e]) => eventHasOurHook(JSON.parse(readFileSync(claudeSettings, "utf8")), e)).map(([e]) => e) : []
  if (dryRun) {
    console.log("Token Norm uninstall plan (host: claude)\n")
    console.log(`  ${existsSync(claudeHookTarget) ? "remove " : "absent "} ${claudeHookTarget}`)
    console.log(
      registered.length > 0
        ? `  unregister  ${claudeSettings} (${registered.join(", ")})`
        : `  unchanged   ${claudeSettings} (no token-norm hooks)`,
    )
    console.log("\n--dry-run: nothing was removed.")
    return
  }
  if (existsSync(claudeHookTarget)) {
    rmSync(claudeHookTarget)
    console.log(`removed ${claudeHookTarget}`)
    const dir = dirname(claudeHookTarget)
    // Only when our own file was the only thing in it. `recursive` is required
    // for a directory even when it is empty; the emptiness check above is what
    // keeps this from removing anything the user put there.
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true })
  }
  if (existsSync(claudeSettings)) {
    const { settings } = readSettingsForWrite()
    const removed = unregisterClaudeHooks(settings)
    if (removed.length > 0) {
      writeSettings(settings)
      console.log(`unregistered ${removed.join(", ")} in ${claudeSettings}`)
    } else {
      console.log(`no token-norm hooks in ${claudeSettings}`)
    }
  }
}

function install() {
  if (host === "claude") return installClaude()
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
  if (host === "claude") return uninstallClaude()
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

function checkClaudeBundle() {
  if (existsSync(claudeBundle)) ok("package bundle", `${readPkgVersion()} at ${claudeBundle}`)
  else fail("package bundle", `missing ${claudeBundle} -- run \`npm run build:claude-hook\``)
}

function checkClaudeHook() {
  if (!existsSync(claudeHookTarget)) {
    fail("hook installed", `not found at ${claudeHookTarget} -- run \`npx opencode-token-norm --host claude\``)
    return
  }
  if (!existsSync(claudeBundle)) {
    warn("hook installed", `${claudeHookTarget} (cannot compare: no bundle in this package)`)
    return
  }
  if (sha256(claudeHookTarget) === sha256(claudeBundle)) ok("hook installed", `${claudeHookTarget} (matches this package)`)
  else warn("hook installed", `${claudeHookTarget} differs from this package -- rerun the installer to update`)
}

/** Installed-but-unregistered is the failure this check exists for: the hook
 * file can be perfect and the host will never run it. */
function checkClaudeRegistration() {
  if (!existsSync(claudeSettings)) {
    fail("hook registration", `${claudeSettings} does not exist -- run \`npx opencode-token-norm --host claude\``)
    return
  }
  let settings
  try {
    settings = JSON.parse(readFileSync(claudeSettings, "utf8"))
  } catch (err) {
    fail("hook registration", `${claudeSettings} is not valid JSON (${String(err instanceof Error ? err.message : err).slice(0, 60)})`)
    return
  }
  const missing = CLAUDE_EVENTS.filter(([event]) => !eventHasOurHook(settings, event)).map(([event]) => event)
  if (missing.length === 0) ok("hook registration", `all ${CLAUDE_EVENTS.length} events in ${claudeSettings}`)
  else if (missing.length === CLAUDE_EVENTS.length) fail("hook registration", `no token-norm hooks in ${claudeSettings} -- run the installer`)
  else warn("hook registration", `not registered for ${missing.join(", ")} -- rerun the installer`)
}

/** Reports the two axes 8d degraded on purpose, so "no context line in the
 * reminder" is a documented state here rather than a suspected bug. */
function checkClaudeAxes() {
  const limit = process.env.TOKEN_NORM_CONTEXT_LIMIT
  if (limit) ok("context axis", `TOKEN_NORM_CONTEXT_LIMIT=${limit}`)
  else warn("context axis", "off -- set TOKEN_NORM_CONTEXT_LIMIT; the transcript records no window size")
  warn("cost axis", "off on this host -- the transcript records tokens, not prices")
}

const MARK = { ok: "\u2713", warn: "!", fail: "\u2717" }

async function doctor() {
  checkNode()
  if (host === "claude") {
    checkClaudeBundle()
    checkClaudeHook()
    checkClaudeRegistration()
    await checkSettings()
    checkClaudeAxes()
  } else {
    checkOpencode()
    checkPackage()
    checkInstalled()
    checkAuditScript()
    await checkSettings()
    checkPython()
    checkDatabase()
    checkDuplicateRegistration()
  }

  console.log(`Token Norm doctor${host === "claude" ? " (host: claude)" : ""}\n`)
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
  console.log("usage: opencode-token-norm [install|doctor|uninstall] [--host HOST] [--dry-run]\n")
  console.log("  install    install or update for --host (default)")
  console.log("  doctor     check the install and report what would break")
  console.log("  uninstall  remove it")
  console.log("")
  console.log(`  --host     ${HOSTS.join(" | ")} (default: opencode)`)
  console.log("               opencode  copy the plugin into ~/.config/opencode/plugins")
  console.log("               claude    copy the hook into ~/.claude/token-norm and merge it")
  console.log("                         into the hooks in ~/.claude/settings.json")
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
