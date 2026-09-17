// Every line the plugin injects into a session, in one place.
//
// The threshold reminders and the handoff skeleton are plain text builders so
// the hook wiring in plugin.ts stays about when to inject, not what to say.

import { attribution } from "../usage.js"
import { fmtBytes } from "./format.js"
import { usage } from "./state.js"

export function boundaryReminder(calls: number): string[] {
  return [
    `TOKEN NORM -- new request arrived ${calls} tool calls deep. This is a TASK BOUNDARY.`,
    `A prior "do everything" / "don't ask" was scoped to the PREVIOUS task. It does not carry.`,
    `Before continuing, in your next message:`,
    `  1. Say whether this request names new files/subsystems (-> new task, not a continuation).`,
    `  2. If new: propose finishing here with a 3-line handoff (done / state / next),`,
    `     and let the user start it fresh. Cold start = system floor + a few targeted reads.`,
    `  3. If the user re-grants the override, proceed -- but state the cost first.`,
    `Do NOT justify continuing with "finishing here beats reloading cold". That reasoning`,
    `is always available, feels free only because this context is already warm, and is the`,
    `exact rationalization the norm exists to block.`,
  ]
}

export function announceReminder(calls: number, tools: string): string[] {
  return [
    `TOKEN NORM -- ${calls} tool calls in this session (${tools}).`,
    `This is now a "big task" under the norm, which required a cost statement BEFORE starting.`,
    `Do this now, in your next message to the user, before more tool calls:`,
    `  1. State remaining expected tool calls and what will drive them.`,
    `  2. State your caps (read windows, smallest test target, no whole-file reads).`,
    `  3. Offer a session split: which part could ship now with a 3-line handoff?`,
    `If the user already said "do everything", the split is overridden -- the cost`,
    `statement and the audit are NOT. Say so explicitly rather than staying silent.`,
  ]
}

export function auditReminder(calls: number, audit: string): string[] {
  return [
    `TOKEN NORM -- ${calls} tool calls. Audit checkpoint (ran for you):`,
    ``,
    audit,
    ``,
    `In your NEXT message, before continuing the task: report the effective-token`,
    `number and the cache multiplier to the user, and say whether you are splitting.`,
    `If work remains: state/done/next in a NOTES file, then propose a fresh session.`,
  ]
}

export function compactionContext(calls: number, tools: string): string {
  return `## Session budget at compaction
This session has made ${calls} tool calls (${tools}).
Compaction is itself evidence the session ran too long for one task.
- Run the usage audit and report the effective-token number to the user.
- Put state/done/next in a NOTES file, not in the rebuilt context.
- Propose finishing here with a 3-line handoff and starting the next task fresh.`
}

export function handoffLines(sessionID: string): string[] {
  const attr = attribution(usage.get(sessionID))
  const files = usage.editedFiles(sessionID)
  const lines = [
    `TOKEN NORM -- HANDOFF RECOMMENDED (budget/context pressure + a natural pause).`,
    `Do not start new work in this session. In your next message:`,
    `  1. Report the evidence below and propose finishing here.`,
    `  2. Fill the skeleton with real paths/identifiers; done/next must be yours, not invented.`,
    `  3. Call the handoff tool once the user agrees.`,
    ``,
    `Attribution (estimated from output bytes, not tokens):`,
  ]
  if (attr.topTools.length > 0) {
    lines.push(`  - top tools: ${attr.topTools.map((t) => `${t.tool} ${fmtBytes(t.bytes)}`).join(", ")}`)
  }
  if (attr.repeated.length > 0) {
    lines.push(`  - repeated reads: ${attr.repeated.map((r) => `${r.file} x${r.count}`).join(", ")}`)
  }
  if (attr.images > 0) lines.push(`  - image/PDF reads: ${attr.images}`)
  lines.push(`  - budgeted tool calls: ${usage.rollup(usage.rootOf(sessionID)).calls}`)
  if (files.length > 0) {
    const shown = files.slice(0, 10).join(", ")
    lines.push(`Files touched: ${shown}${files.length > 10 ? ` (+${files.length - 10} more)` : ""}`)
  }
  lines.push(``, `Skeleton:`, `Task: <one line>`, `Done: <finished and verified>`, `Next: <exact first action>`)
  return lines
}
