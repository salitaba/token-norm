import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

/** A setting that was present but unusable, plus what was used instead.
 * Collected rather than logged here: log.ts imports this module, so config
 * cannot import the logger back. The plugins drain this at load. */
export type ConfigDiagnostic = {
  name: string
  raw: string
  reason: string
  /** Rendered value of the fallback that was used instead. */
  using: string
}

const diagnostics: ConfigDiagnostic[] = []

function reject(name: string, raw: string, reason: string, using: unknown): void {
  diagnostics.push({ name, raw, reason, using: using === undefined ? "no limit" : String(using) })
}

/** Every setting this module reads. Anything else under the TOKEN_NORM_ prefix
 * is a typo that would otherwise be ignored in silence. */
const KNOWN_KEYS = new Set<string>()

function env(name: string): string | undefined {
  KNOWN_KEYS.add(name)
  return process.env[name]
}

function num(name: string, fallback: number): number {
  const raw = env(name)
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  reject(name, raw, "expected a positive integer", fallback)
  return fallback
}

/** `num` cannot read fractions (`0.80` parses to 0 and falls back), and
 * TOKEN_NORM_CONTEXT_WARN is a fraction. */
function float(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name)
  if (!raw) return fallback
  const parsed = Number.parseFloat(raw)
  if (Number.isFinite(parsed) && parsed >= min && parsed <= max) return parsed
  reject(name, raw, `expected a number between ${min} and ${max}`, fallback)
  return fallback
}

/** A configured budget. Absent, zero, or malformed means "no budget for this
 * metric" rather than a zero budget that blocks all work. */
function optional(name: string): number | undefined {
  const raw = env(name)
  if (!raw) return undefined
  const parsed = Number.parseFloat(raw)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  reject(name, raw, "expected a positive number", undefined)
  return undefined
}

/** Kill switches compare against "0", so a plausible-looking "false" or "off"
 * silently leaves the half enabled. That is the wrong way round to fail. */
function killSwitch(name: string): boolean {
  const raw = env(name)
  if (raw === undefined || raw === "0" || raw === "1") return raw !== "0"
  reject(name, raw, 'expected "0" (off) or "1" (on)', "1")
  return true
}

/** Norm: ">~30 tool calls" needs an up-front cost statement. Warn slightly
 * early so the announcement can still change the plan instead of narrating it. */
export const ANNOUNCE_AT = num("TOKEN_NORM_ANNOUNCE_AT", 25)

/** Norm: "once midway through long tasks". Then keep reminding, because one
 * notice 120 calls ago is not a live constraint. */
export const AUDIT_EVERY = num("TOKEN_NORM_AUDIT_EVERY", 60)

/** A session that is already large is where a NEW user request should start a
 * fresh session instead of inheriting the old context. Below this, the handoff
 * costs more than it saves. */
export const BOUNDARY_AT = num("TOKEN_NORM_BOUNDARY_AT", 40)

/** Tools that do not count toward the budget. Planning and asking should not
 * burn it; reads and greps do, because context is what you pay for. */
const CHEAP_TOOLS_DEFAULT = "todowrite,question,skill"

/** An empty or all-whitespace list would make every tool billable, which looks
 * like the plugin miscounting rather than like a config mistake. */
function cheapTools(): Set<string> {
  const raw = env("TOKEN_NORM_CHEAP_TOOLS")
  const parsed = (raw ?? CHEAP_TOOLS_DEFAULT)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
  if (raw !== undefined && parsed.length === 0) {
    reject("TOKEN_NORM_CHEAP_TOOLS", raw, "expected a comma-separated tool list", CHEAP_TOOLS_DEFAULT)
    return new Set(CHEAP_TOOLS_DEFAULT.split(","))
  }
  return new Set(parsed)
}

export const CHEAP_TOOLS = cheapTools()

/** `name=weight` comma lists. The name is a tool id or an assistant mode; an
 * unlisted name weighs 1, and a malformed entry is dropped and reported. */
function weightList(name: string): Map<string, number> {
  const raw = env(name)
  const out = new Map<string, number>()
  if (raw === undefined) return out
  for (const entry of raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const eq = entry.indexOf("=")
    const key = eq > 0 ? entry.slice(0, eq).trim() : ""
    const value = Number(entry.slice(eq + 1).trim())
    if (!key || !Number.isFinite(value) || value <= 0) {
      reject(name, entry, "expected name=weight with a positive weight", "weight 1")
      continue
    }
    out.set(key, value)
  }
  return out
}

export const TOOL_WEIGHTS = weightList("TOKEN_NORM_TOOL_WEIGHTS")
export const PHASE_WEIGHTS = weightList("TOKEN_NORM_PHASE_WEIGHTS")

export function weightOf(tool: string, mode: string | undefined): number {
  return (TOOL_WEIGHTS.get(tool) ?? 1) * (PHASE_WEIGHTS.get(mode ?? "") ?? 1)
}

const DATA_HOME = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")

export const HANDOFF_DIR = env("TOKEN_NORM_HANDOFF_DIR") || path.join(DATA_HOME, "opencode", "handoff")

export const LOG_PATH = env("TOKEN_NORM_LOG") || path.join(DATA_HOME, "opencode", "token-norm.log")

/** Session counters live under XDG_STATE_HOME, not XDG_DATA_HOME: they are
 * state the program reproduces on its own and that a user may delete without
 * losing anything they authored, which is exactly the distinction the two
 * directories draw. Handoff notes stay in DATA_HOME -- those the user wrote. */
const STATE_HOME = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")

/** Per-host so two hosts observing the same machine cannot collide on a
 * session id, and so uninstalling one host's hooks leaves the others alone. */
export function stateDir(host: string): string {
  const override = env("TOKEN_NORM_STATE_DIR")
  return override ? path.join(override, host) : path.join(STATE_HOME, "token-norm", host)
}

/** Resolved relative to the installed package, not to the user's config dir,
 * so the bundled script is found wherever npm/bun placed the package.
 *
 * Found by walking up rather than by a fixed count of "..", because no single
 * depth is right for every build of this file: tsc emits it to dist/core/,
 * esbuild inlines it into a bundle at dist/, and vitest loads it from src/core/.
 * A hard-coded "../scripts" silently pointed at a directory that does not exist
 * in two of those three layouts. */
function packagedAuditScript(): string {
  const start = path.dirname(fileURLToPath(import.meta.url))
  let dir = start
  for (let up = 0; up < 5; up++) {
    const candidate = path.join(dir, "scripts", "usage-audit.py")
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Nothing found: name the conventional location so the error message the
  // audit prints points somewhere a user can act on.
  return path.join(start, "..", "scripts", "usage-audit.py")
}

export const AUDIT_SCRIPT = env("TOKEN_NORM_AUDIT_SCRIPT") || packagedAuditScript()

export const PYTHON = env("TOKEN_NORM_PYTHON") || "python3"

/** Opt out of one half without uninstalling the package. */
export const BUDGET_ENABLED = killSwitch("TOKEN_NORM_BUDGET")
export const HANDOFF_ENABLED = killSwitch("TOKEN_NORM_HANDOFF")

/** How hard the budget bites. `warn` is the default and preserves the
 * plugin's historical behavior. `observe` logs crossings but injects nothing
 * (used to validate the context formula against real compactions). `handoff`
 * adds a skeleton at the next pause. `block` refuses non-cheap tool calls and
 * is opt-in only -- "don't break the user's work" still stands. */
export type BudgetMode = "observe" | "warn" | "handoff" | "block"

const MODES = ["observe", "warn", "handoff", "block"]

function mode(): BudgetMode {
  const raw = env("TOKEN_NORM_MODE")
  if (!raw) return "warn"
  if (MODES.includes(raw)) return raw as BudgetMode
  reject("TOKEN_NORM_MODE", raw, `expected one of ${MODES.join(", ")}`, "warn")
  return "warn"
}

export const MODE: BudgetMode = mode()

export const MAX_COST = optional("TOKEN_NORM_MAX_COST")
export const MAX_EFFECTIVE_TOKENS = optional("TOKEN_NORM_MAX_EFFECTIVE_TOKENS")
export const MAX_TOOL_CALLS = optional("TOKEN_NORM_MAX_TOOL_CALLS")

/** Fraction of the context window that counts as pressure. */
export const CONTEXT_WARN = float("TOKEN_NORM_CONTEXT_WARN", 0.8, 0, 1)

/** Explicit window size; overrides the model limit resolved from the client. */
export const CONTEXT_LIMIT = optional("TOKEN_NORM_CONTEXT_LIMIT")

/** Handoff switch timing. Read here, not in handoff.ts, so a malformed value
 * is diagnosed like every other setting. */
export const SETTLE_MS = num("TOKEN_NORM_SETTLE_MS", 350)
export const SWITCH_WAIT = num("TOKEN_NORM_SWITCH_WAIT_MS", 2000)

/** Unknown TOKEN_NORM_* keys are almost always typos of a real setting; left
 * unreported they look like the setting was applied and had no effect. */
function unknownKeys(): void {
  for (const name of Object.keys(process.env)) {
    if (!name.startsWith("TOKEN_NORM_") || KNOWN_KEYS.has(name)) continue
    reject(name, process.env[name] ?? "", "unknown setting (typo?)", "ignored")
  }
}

unknownKeys()

/** Drains the collected diagnostics. Callers report them; leaving them in place
 * would repeat the same warnings for every plugin half that asks. */
export function takeConfigDiagnostics(): ConfigDiagnostic[] {
  return diagnostics.splice(0, diagnostics.length)
}
