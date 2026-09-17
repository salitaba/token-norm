// The process boundary: stdin -> adapter -> stdout, and always exit 0.
//
// EXIT CODE DISCIPLINE. Codex reads a non-zero exit as a hook failure, and its
// own hook log says exit 2 specifically means "block this call" ("PreToolUse
// hook exited with code 2 but did not write a blocking reason to stderr", read
// out of the binary), so a crash in the counting path would refuse the user's
// tool call. Everything here funnels to exit 0 and an empty stdout; the only
// refusal this adapter ever issues is a deliberate `permissionDecision: "deny"`
// in opt-in block mode.

import { pathToFileURL } from "node:url"

import { stateDir } from "../../core/config.js"
import { setStateStore, stateCodec } from "../../core/budget/state.js"
import { DiskStore } from "../../runtime/store.js"
import { handleHook, type AdapterDeps } from "./adapter.js"
import { parseHookInput, type HookOutput } from "./protocol.js"

export const HOST = "codex"

/** A hook process dies after one event, so the counters have to live on disk.
 * Called before dispatch; every importer of `state` follows the live binding. */
export function installStore(): void {
  setStateStore(new DiskStore(stateDir(HOST), stateCodec))
}

/** Payloads are small (a tool's input and response). The cap exists so a
 * pathological one cannot make the hook the reason the session stalls. */
export const MAX_INPUT_BYTES = 8 * 1024 * 1024

export async function readStdin(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: string[] = []
  let bytes = 0
  for await (const chunk of stream) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
    bytes += Buffer.byteLength(text)
    if (bytes > MAX_INPUT_BYTES) break
    chunks.push(text)
  }
  return chunks.join("")
}

/** The whole adapter as one pure-ish string->string step, so a test can drive a
 * full hook invocation without a process. Returns "" when there is nothing to
 * say, which the runner turns into empty stdout. */
export function hookResponse(raw: string, deps?: AdapterDeps): string {
  let output: HookOutput | undefined
  try {
    output = handleHook(parseHookInput(raw), deps)
  } catch {
    // Belt and braces: handleHook already swallows its own failures, and if a
    // new path ever stops doing so, the tool call must still succeed.
    return ""
  }
  if (!output) return ""
  try {
    return JSON.stringify(output)
  } catch {
    return ""
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  void argv
  try {
    installStore()
    const raw = await readStdin(process.stdin)
    const body = hookResponse(raw)
    if (body) process.stdout.write(body + "\n")
  } catch {
    /* see EXIT CODE DISCIPLINE above */
  }
  return 0
}

// Run directly when invoked as a script, so `node dist/hosts/codex/main.js` is a
// working hook command today. The unified `token-norm hook <host> <event>`
// binary (build order step 15) imports `main` instead of duplicating this.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  process.exitCode = await main()
}
