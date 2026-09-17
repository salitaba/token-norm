// The host surface this plugin depends on -- and nothing else.
//
// WHY THIS EXISTS
// The plugin used to take the opencode client as `any`. That is not a typing
// nicety: `any` means a renamed or removed host method fails at RUNTIME, inside
// a try/catch whose whole job is to swallow failures so a budget bug never
// breaks a tool call. The two guarantees combine into silence -- the plugin
// keeps loading and quietly stops reporting.
//
// So the client is declared here as the narrow set of calls actually made, and
// the real client is checked against it at the plugin entry points. Declaring
// only the used fields is deliberate: a full mirror of the SDK would go stale
// on every host release for methods this plugin never calls, and would make
// test fakes impossible to write without stubbing the whole API.
//
// Every member is optional or guarded the same way the runtime guards it, so
// these types describe what the code assumes, not what the host promises.

export type ToastVariant = "info" | "success" | "warning" | "error"

export interface ToastRequest {
  body: { title: string; message: string; variant: ToastVariant }
}

/** The only client call the budget half makes for user-visible output. */
export interface ToastClient {
  tui?: {
    showToast?: (request: ToastRequest) => unknown
  }
}

/** Model window lookup. `providers()` is read for `limit.context` only; the
 * response is unwrapped as `data.providers` or `providers` because both shapes
 * have been observed across client versions. */
export interface ProviderModel {
  limit?: { context?: number }
}

export interface ProviderInfo {
  id?: string
  models?: Record<string, ProviderModel | undefined>
}

export interface ProvidersResponse {
  data?: { providers?: ProviderInfo[] }
  providers?: ProviderInfo[]
}

export interface ProviderClient {
  config?: {
    providers?: () => Promise<ProvidersResponse | undefined>
  }
}

/** What the budget plugin needs: a toast channel and the model window. */
export interface BudgetClient extends ToastClient, ProviderClient {}

export interface AgentInfo {
  name?: string
  mode?: string
}

export interface AgentsResponse {
  data?: AgentInfo[]
}

/** What the handoff tool needs. These are NOT optional: a handoff that cannot
 * drive the TUI has no fallback worth having, and the call sites are wrapped in
 * their own error handling. */
export interface HandoffClient {
  app: {
    agents: () => Promise<AgentsResponse | AgentInfo[] | undefined>
  }
  tui: {
    executeCommand: (request: { body: { command: string } }) => unknown
    appendPrompt: (request: { body: { text: string } }) => unknown
    submitPrompt: () => unknown
    showToast: (request: ToastRequest) => unknown
  }
}

// --- Events ----------------------------------------------------------------
//
// Only the properties this plugin reads are declared, all optional: events
// arrive from a host that may add, drop or reshape fields between releases, and
// every consumer here already narrows with a runtime check. Declaring them
// optional keeps those checks meaningful instead of typing a promise the host
// never made.

export interface RawTokens {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

/** A `step-finish` part: the single source of measured cost and tokens. */
export interface StepPart {
  type?: string
  id?: string
  sessionID?: string
  cost?: number
  tokens?: RawTokens
  messageID?: string
}

export interface MessageInfo {
  id?: string
  sessionID?: string
  role?: string
  providerID?: string
  modelID?: string
  mode?: string
}

export interface SessionInfo {
  id?: string
  parentID?: string
  time?: { created?: number }
}

export interface TodoItem {
  status?: string
}

export interface NormEventProperties {
  sessionID?: string
  /** `session.*` events carry a session; `message.updated` carries a message. */
  info?: SessionInfo & MessageInfo
  part?: StepPart
  todos?: TodoItem[]
  file?: string
}

export interface NormEvent {
  type?: string
  properties?: NormEventProperties
}

/** The host's `Event` is a discriminated union covering every event it emits,
 * including ones whose `properties` share no field with the handful read here
 * (`server.instance.disposed` carries only `directory`). TypeScript therefore
 * rejects a direct assignment even though every read below is runtime-guarded.
 *
 * This is the single place that narrowing is allowed to happen. Widening at
 * each call site instead would scatter casts through the event handlers and
 * hide the one assumption worth naming: an event is an object, and every field
 * this plugin reads may be absent. */
export function asNormEvent(event: unknown): NormEvent | undefined {
  if (!event || typeof event !== "object") return undefined
  return event as NormEvent
}

/** Tool args are read for `filePath` only (read/edit attribution). */
export interface ToolArgs {
  filePath?: unknown
}
