import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { LOG_PATH, takeConfigDiagnostics } from "./config.js"

export function log(line: string): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* logging must never break a session */
  }
}

/** A setting that was typed but not honored is a silent no-op: the user thinks
 * the budget is configured and it is not. Say so once, at load, and return the
 * lines so a caller can also surface them in the UI. Drains the queue, so the
 * second plugin half to load reports nothing. */
export function logConfigDiagnostics(): string[] {
  const lines = takeConfigDiagnostics().map(
    (d) => `config: ${d.name}=${JSON.stringify(d.raw)} ignored -- ${d.reason}; using ${d.using}`,
  )
  for (const line of lines) log(line)
  return lines
}
