// The Codex host. Public surface for the installer and the eventual
// `token-norm hook <host> <event>` CLI (build order step 15); the policy itself
// lives in src/core/ and is shared with every other host.

export { handleHook, type AdapterDeps } from "./adapter.js"
export { HOST, hookResponse, installStore, main, readStdin, MAX_INPUT_BYTES } from "./main.js"
export {
  denyToolCall,
  hookEventOf,
  injectContext,
  parseHookInput,
  resumesContext,
  type CodexHookEvent,
  type HookInput,
  type HookOutput,
  type HookSpecificOutput,
  type PermissionDecision,
} from "./protocol.js"
export {
  mainWindowTurn,
  measureSession,
  sessionSpend,
  stepTokens,
  transcriptAudit,
  windowOccupancy,
  type CodexMeasurement,
} from "./measure.js"
