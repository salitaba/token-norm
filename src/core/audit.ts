import { execFileSync } from "node:child_process"
import { AUDIT_SCRIPT, PYTHON } from "./config.js"

const KEEP_LINE = /^(totals|effective|calls|cacheR?|cache)\b/

/**
 * Run the usage audit and return a compact result. Must never throw and must
 * never hang: a checkpoint that breaks the session is worse than no checkpoint.
 */
export function runAudit(sessionID?: string): string {
  try {
    const args = sessionID ? ["--session", sessionID] : ["--last"]
    const out = execFileSync(PYTHON, [AUDIT_SCRIPT, ...args], {
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024 * 1024,
    })
    // Keep only the lines that change a decision; the full table is noise here.
    const keep = out
      .split("\n")
      .filter((l) => KEEP_LINE.test(l.trim()))
      .join("\n")
    return keep.trim() || out.trim().slice(0, 800)
  } catch (err) {
    const reason = String(err instanceof Error ? err.message : err).slice(0, 160)
    const flag = sessionID ? `--session ${sessionID}` : "--last"
    return [
      `(usage-audit did not run: ${reason})`,
      `It needs python3 and opencode's local db. Run it manually:`,
      `  ${PYTHON} ${AUDIT_SCRIPT} ${flag}`,
    ].join("\n")
  }
}
