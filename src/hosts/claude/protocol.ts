// The Claude Code hook wire format: what arrives on stdin, what may be written
// to stdout, and nothing else.
//
// VERIFIED AGAINST THE INSTALLED HOST (Claude Code 2.1.274), not against docs.
// The field that matters is the injection one, and getting it wrong is the
// failure mode this whole project exists to prevent:
//
//   systemMessage       - "Display a message to the user (all hooks)"
//   hookSpecificOutput
//     .additionalContext  - "Text injected into model context"
//
// Earlier research reported `systemMessage` as the injection field. It is not:
// it renders to the human and the model never sees it, so every reminder would
// have been delivered to the one party that cannot act on it, and the hook
// would have looked healthy from the outside the entire time. The reminder goes
// in `additionalContext`; `systemMessage` is for the operator-facing line only.
//
// `hookSpecificOutput` MUST carry `hookEventName` -- the host rejects it
// otherwise, with the hint "Did you mean hookSpecificOutput.additionalContext
// (with a hookEventName)?".

/** Events this adapter answers to. The host has more; these are the ones with
 * a counterpart in the opencode plugin. */
export type ClaudeHookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "UserPromptSubmit"
  | "Stop"
  | "SessionEnd"
  | "SessionStart"

/** stdin. Every field is optional: this is another program's JSON, and a hook
 * that throws on a missing key fails the tool call it was supposed to observe. */
export interface HookInput {
  hook_event_name?: string
  session_id?: string
  transcript_path?: string
  cwd?: string
  tool_name?: string
  tool_input?: unknown
  tool_response?: unknown
  /** SessionStart only. The host's own schema for this event declares
   * `source: ["startup","resume","clear","compact","fork"]` (read out of Claude
   * Code 2.1.274, not from docs). It is the difference between a session that
   * needs the handoff note injected and one that already holds the context the
   * note summarises -- see `resumesContext`. */
  source?: string
}

export type PermissionDecision = "allow" | "deny" | "ask"

export interface HookSpecificOutput {
  hookEventName: string
  /** Model-visible. This is where a reminder goes. */
  additionalContext?: string
  /** PreToolUse only. */
  permissionDecision?: PermissionDecision
  permissionDecisionReason?: string
}

export interface HookOutput {
  /** User-visible only -- never the carrier for a reminder. */
  systemMessage?: string
  suppressOutput?: boolean
  hookSpecificOutput?: HookSpecificOutput
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** Parse stdin. Returns undefined for anything that is not a JSON object, which
 * the caller treats as "nothing to do" rather than as an error: the tool call
 * has already happened and refusing to parse cannot undo it. */
export function parseHookInput(raw: string): HookInput | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  return {
    hook_event_name: str(parsed.hook_event_name),
    session_id: str(parsed.session_id),
    transcript_path: str(parsed.transcript_path),
    cwd: str(parsed.cwd),
    tool_name: str(parsed.tool_name),
    tool_input: parsed.tool_input,
    tool_response: parsed.tool_response,
    source: str(parsed.source),
  }
}

const EVENTS: ReadonlySet<string> = new Set<ClaudeHookEvent>([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
  "SessionStart",
])

export function hookEventOf(input: HookInput | undefined): ClaudeHookEvent | undefined {
  const name = input?.hook_event_name
  return name !== undefined && EVENTS.has(name) ? (name as ClaudeHookEvent) : undefined
}

/** Inject text into the model's context. */
export function injectContext(event: ClaudeHookEvent, text: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } }
}

/** Refuse a tool call. `permissionDecision` rather than the legacy top-level
 * `decision: "block"`, which the host documents as deprecated for PreToolUse. */
export function denyToolCall(reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }
}

/** Does this SessionStart already carry the previous context?
 *
 * `resume` and `fork` continue a transcript; `compact` replaces it with a
 * summary of itself. In all three the model can already see the work the
 * handoff note describes, so injecting the note duplicates it -- and on
 * `compact` it re-injects precisely what compaction was run to discard.
 * Only `startup` and `clear` begin with an empty window.
 *
 * An unknown source is treated as resuming, so a source this adapter has not
 * seen fails closed (no injection) rather than injecting into a live session.
 */
export function resumesContext(source: string | undefined): boolean {
  return source !== "startup" && source !== "clear"
}
