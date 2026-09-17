// Session handoff ("new session per task with a 3-line handoff").
//
// The norm says split at phase boundaries. In practice the split does not
// happen, because splitting means the user leaving the TUI, opening a new
// session, and re-typing context by hand -- three manual steps at exactly the
// moment the warm session feels cheapest to continue. So the rule loses to
// friction every time.
//
// This makes the split one tool call. The agent writes the handoff, the plugin
// persists it to disk, opens a NEW TUI session, pre-fills its prompt with the
// handoff text, and submits it -- the cold session starts working immediately.
//
// Pass submit: false to stop at the pre-filled prompt instead. That beat exists
// for handoffs the user may want to redirect before any tokens burn.

import { tool, type Plugin, type PluginInput } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { HANDOFF_DIR, SETTLE_MS, SWITCH_WAIT } from "./core/config.js"
import { asNormEvent, type HandoffClient } from "./core/host.js"
import { log, logConfigDiagnostics } from "./core/log.js"

// The TUI processes /tui/execute-command asynchronously: the request returns
// once the command is dispatched, not once the new session is mounted.
// Appending the prompt too early lands the text in the OLD session's editor,
// which is worse than not splitting at all -- the user sees nothing and the
// handoff is lost.
//
// No V1 API exposes a readiness signal (every TUI endpoint returns a boolean),
// so the wait uses the `session.created` event as evidence, with the old fixed
// delay as a floor and a bounded fallback. Fast machines behave exactly as
// before; a slow switch waits for proof instead of guessing.
const SWITCH_SETTLE_MS = SETTLE_MS
const SWITCH_WAIT_MS = SWITCH_WAIT

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface HandoffArgs {
  task: string
  done: string
  next: string
  files?: string[]
  notes?: string
  submit?: boolean
}

// Plugin tools register for EVERY agent, subagents included. A subagent calling
// handoff would open a new TUI session in the middle of the parent's task --
// hijacking the user's screen for work they did not ask to split. Only a
// primary agent owns the session, so only a primary agent may end it.
//
// Resolved from the live agent list instead of a hardcoded name list, so agents
// the user adds later are classified correctly without touching this file.
async function isSubagent(client: HandoffClient, agentName: string | undefined): Promise<boolean> {
  if (!agentName) return false
  try {
    const res = await client.app.agents()
    const agents = Array.isArray(res) ? res : res?.data
    const found = Array.isArray(agents) ? agents.find((a) => a?.name === agentName) : undefined
    return found?.mode === "subagent"
  } catch {
    // If the lookup fails, allow. A false block would strand the primary agent
    // with no way to split, which is the failure this plugin exists to prevent.
    return false
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
}

function renderHandoff({ task, done, next, files, notes }: HandoffArgs): string {
  const lines = [`## Handoff`, ``, `**Task:** ${task}`, `**Done:** ${done}`, `**Next:** ${next}`]
  if (files?.length) {
    lines.push(``, `**Files in play:**`)
    for (const f of files) lines.push(`- ${f}`)
  }
  if (notes) lines.push(``, `**Notes:**`, notes)
  return lines.join("\n")
}

// Only the TUI calls the handoff drives, plus the directory it stamps into the
// note. Declared narrowly so a host rename fails at build time rather than at
// the one moment the user is counting on the split to work.
type HandoffPluginInput = Partial<Omit<PluginInput, "client">> & { client: HandoffClient }

export const HandoffPlugin: Plugin = async ({ client, directory }: HandoffPluginInput) => {
  // Reported here as well as in the budget half, because either half can be
  // loaded alone. The drain makes the second caller a no-op when both load.
  logConfigDiagnostics()

  // Set while a handoff is waiting for its new session to exist; the event hook
  // below resolves it. `null` means no switch is in flight.
  let sessionSwitched: { startedAt: number; resolve: () => void } | null = null

  return {
    event: async (input) => {
      if (!sessionSwitched) return
      const event = asNormEvent(input?.event)
      if (event?.type !== "session.created") return
      const info = event.properties?.info
      // Subagent sessions also emit session.created; only a primary (parentless)
      // session is evidence that the TUI's switch landed.
      if (!info?.id || info.parentID) return
      // A late event from an earlier, already-timed-out switch must not satisfy
      // this waiter: only sessions created after this wait began count. 250ms of
      // slack absorbs clock rounding. V1 types `Session.time.created` as a
      // required number, so an untimed event cannot be proven fresh -- and it
      // cannot be told apart from a stale one. Ignore it; the bounded timeout
      // below still appends after the settle floor, so the degradation is a
      // slower handoff, never a prompt in the wrong session.
      const created = info.time?.created
      if (typeof created !== "number" || created < sessionSwitched.startedAt - 250) return
      const waiter = sessionSwitched
      sessionSwitched = null
      waiter.resolve()
    },

    tool: {
      handoff: tool({
        description: [
          "End the current session at a phase boundary and continue in a FRESH session.",
          "Persists a handoff note to disk, opens a new TUI session, pre-fills its prompt",
          "with that note, and submits it so the fresh session starts immediately.",
          "",
          "Use when: diagnosis is done and implementation has not started; the user asks for a",
          "new/clean session; context is large and the remaining work does not need the",
          "accumulated tool output; or the session-budget audit says to split.",
          "",
          "Write the handoff for a reader with ZERO context. Name real file paths and real",
          "identifiers you verified this session -- the new session cannot see your scrollback.",
        ].join("\n"),
        args: {
          task: tool.schema.string().describe("The one-line task the next session must accomplish."),
          done: tool.schema
            .string()
            .describe("What is already finished and verified. Be concrete; include findings worth keeping."),
          next: tool.schema.string().describe("The exact next action the fresh session should take first."),
          files: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Absolute paths (file:line where useful) the next session will need to open."),
          notes: tool.schema
            .string()
            .optional()
            .describe("Decisions, constraints, dead ends already ruled out, verified identifiers/commands."),
          submit: tool.schema
            .boolean()
            .optional()
            .describe(
              "Auto-submit the handoff in the new session. Default true: the fresh session starts immediately. Pass false to pre-fill and wait for enter.",
            ),
        },
        async execute(args, ctx) {
          if (await isSubagent(client, ctx.agent)) {
            return {
              title: "Handoff refused",
              output: [
                `handoff is not available to subagents (you are "${ctx.agent}", mode: subagent).`,
                `Return your findings to the parent agent and let it decide whether to split.`,
              ].join("\n"),
              metadata: { refused: "subagent", agent: ctx.agent },
            }
          }

          const autoSubmit = args.submit !== false
          const body = renderHandoff(args)

          // 0700/0600: the note can quote repo paths and findings, so it is
          // private by default. Modes are creation-time only (umask applies);
          // directories that already exist keep their current permissions.
          await fs.mkdir(HANDOFF_DIR, { recursive: true, mode: 0o700 })
          // The timestamp is second-precision, so two handoffs from one session
          // in the same second would collide and the second write would silently
          // destroy the first note. The UUID makes the name unique per call.
          const notePath = path.join(HANDOFF_DIR, `${stamp()}-${randomUUID()}-${ctx.sessionID}.md`)
          // Persist BEFORE switching. If the TUI call fails, the handoff still
          // exists on disk and the user can recover it manually; the reverse
          // ordering would lose the note on exactly the failure that matters.
          await fs.writeFile(notePath, `${body}\n\n_from session ${ctx.sessionID} in ${directory}_\n`, {
            encoding: "utf8",
            mode: 0o600,
          })
          log(`${ctx.sessionID} handoff written to ${notePath}`)

          const prompt = `${body}\n\n_Handoff note: ${notePath}_\n`

          const startedAt = Date.now()
          let settle: (() => void) | null = null
          const switched = new Promise<void>((resolve) => {
            settle = resolve
          })
          const waiter = { startedAt, resolve: settle! }
          sessionSwitched = waiter
          try {
            await client.tui.executeCommand({ body: { command: "session_new" } })
            const confirmed = await Promise.race([
              switched.then(() => true),
              sleep(SWITCH_WAIT_MS).then(() => false),
            ])
            if (!confirmed) {
              log(`${ctx.sessionID} no session.created in ${SWITCH_WAIT_MS}ms; appending after the settle floor`)
            }
          } finally {
            // Every exit path must disarm the waiter -- the timeout, a thrown
            // executeCommand, anything. A stale resolver left behind could be
            // satisfied by a late session.created and clear the NEXT handoff's
            // waiter before its own session exists.
            if (sessionSwitched === waiter) sessionSwitched = null
          }
          // Floor: even on the event path, give the TUI the minimum time the
          // fixed delay always provided, so fast machines do not regress.
          const elapsed = Date.now() - startedAt
          if (elapsed < SWITCH_SETTLE_MS) await sleep(SWITCH_SETTLE_MS - elapsed)
          await client.tui.appendPrompt({ body: { text: prompt } })
          if (autoSubmit) await client.tui.submitPrompt()

          await client.tui.showToast({
            body: {
              title: "Handoff",
              message: autoSubmit ? "New session started" : "New session ready — press enter",
              variant: "success",
            },
          })

          return {
            title: "Handed off to new session",
            output: [
              `Handoff written to ${notePath}`,
              `New session opened; prompt ${autoSubmit ? "submitted" : "pre-filled (awaiting enter)"}.`,
              ``,
              `STOP HERE. This session is over. Do not continue the task, do not make further`,
              `tool calls, and do not summarize beyond one line — the work now belongs to the`,
              `new session. Continuing here spends the context the handoff exists to discard.`,
            ].join("\n"),
            metadata: { notePath, submitted: autoSubmit },
          }
        },
      }),
    },
  }
}
