// The Codex hook wire format: what arrives on stdin, what may be written to
// stdout, and nothing else.
//
// VERIFIED FROM THE INSTALLED BINARY, not from docs, and read TWICE because the
// first reading was wrong. Both are recorded in docs/multi-host-port.md: §9h
// took serde's concatenated field-name blob, which is the union of every struct
// in the module -- fine for "which fields exist anywhere here", wrong for "does
// event X carry field Y". §9i read the draft-07 JSON Schema the binary embeds
// for the app-server protocol, which is authoritative for the OUTPUT wire, and
// this file follows §9i.
//
// The output shape is Claude Code's, down to the field names:
//
//   systemMessage                   - user-visible only, never a reminder
//   hookSpecificOutput
//     .hookEventName                - REQUIRED by the schema
//     .additionalContext            - model-visible; the reminder goes here
//     .permissionDecision           - PreToolUse only
//     .permissionDecisionReason     - PreToolUse only
//
// `PreToolUsePermissionDecisionWire` is ["allow","deny","ask"] -- read out of
// the schema, and identical to Claude's. So the reminder/reason split in §9c
// holds verbatim here and the Claude helpers port rather than being translated.

/** Events this adapter answers to, out of the eleven the schema declares:
 * SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse,
 * PermissionRequest, PreCompact, PostCompact, SubagentStart, SubagentStop,
 * Stop. The rest resolve to "nothing to do" through `hookEventOf` rather than
 * being read as corruption -- §9a found the host's own hooks file already
 * carries several groups per event.
 *
 * `PostToolUseFailure` is deliberately absent: it does not exist on this host
 * (0 occurrences in the binary), so the failed-call branch the Claude adapter
 * needs has no counterpart here and must not be invented. */
export type CodexHookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "SessionEnd"
  | "SessionStart"

/** stdin. Every field is optional: this is another program's JSON, and a hook
 * that throws on a missing key fails the tool call it was supposed to observe.
 *
 * This is the union over Codex's per-event input structs, read out of the
 * binary. Two of them are the reason §9i re-read the file:
 * `tool_name` IS present on the tool events, so call counting works exactly as
 * it does on Claude Code; and `cwd` IS present on at least the PreToolUse-shaped
 * struct, so §9h's "cwd is not among the hook input fields" was an artefact of
 * sampling a session-level struct. There is no input schema in the binary (only
 * outputs are schema'd), so the adapter still treats `cwd` as optional and falls
 * back to the transcript's own `session_meta` -- correct under both readings. */
export interface HookInput {
  hook_event_name?: string
  session_id?: string
  transcript_path?: string
  /** Present on the tool-event inputs; not confirmed on the session-level ones.
   * See `cwdFor` in adapter.ts for the fallback. */
  cwd?: string
  tool_name?: string
  tool_input?: unknown
  tool_response?: unknown
  turn_id?: string
  tool_use_id?: string
  model?: string
  permission_mode?: string
  trigger?: string
  agent_type?: string
  /** A subagent writes its own rollout (§9h), and its spend lives there rather
   * than in this session's file. */
  agent_transcript_path?: string
  last_assistant_message?: string
  prompt?: string
  /** SessionStart only. `startup | resume | clear | compact` -- four values,
   * and `fork` is not one of them (read out of the binary, §9h). Claude Code's
   * enum is five, so this is Codex's own enum and not a copy of Claude's; only
   * the `resumesContext` predicate transfers. */
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
    turn_id: str(parsed.turn_id),
    tool_use_id: str(parsed.tool_use_id),
    model: str(parsed.model),
    permission_mode: str(parsed.permission_mode),
    trigger: str(parsed.trigger),
    agent_type: str(parsed.agent_type),
    agent_transcript_path: str(parsed.agent_transcript_path),
    last_assistant_message: str(parsed.last_assistant_message),
    prompt: str(parsed.prompt),
    source: str(parsed.source),
  }
}

const EVENTS: ReadonlySet<string> = new Set<CodexHookEvent>([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
  "SessionStart",
])

export function hookEventOf(input: HookInput | undefined): CodexHookEvent | undefined {
  const name = input?.hook_event_name
  return name !== undefined && EVENTS.has(name) ? (name as CodexHookEvent) : undefined
}

/** Inject text into the model's context. */
export function injectContext(event: CodexHookEvent, text: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } }
}

/** Refuse a tool call. Same field names and same enum as Claude Code's, verified
 * from both schemas, so this is one wire format with two hosts behind it. */
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
 * §9h: Codex's `source` enum is `startup | resume | clear | compact`. `resume`
 * continues a transcript; `compact` replaces it with a summary of itself. In
 * both the model can already see the work the handoff note describes, so
 * injecting duplicates it -- and on `compact` it re-injects precisely what
 * compaction was run to discard. Only `startup` and `clear` begin empty.
 *
 * The predicate transfers from `hosts/claude/protocol.ts` unchanged even though
 * the enum does not: an unknown or absent source is treated as resuming, so a
 * value this adapter has not seen fails closed rather than injecting into a
 * live session.
 */
export function resumesContext(source: string | undefined): boolean {
  return source !== "startup" && source !== "clear"
}
