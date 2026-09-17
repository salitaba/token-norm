import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, beforeEach, describe, expect, it } from "vitest"

const script = fileURLToPath(new URL("../scripts/install-local.mjs", import.meta.url))
const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const packagedBundle = path.join(repoRoot, "dist", "claude-hook.mjs")

// Every event the Claude adapter answers to. SessionStart is the odd one out:
// it has no opencode counterpart, because it exists to recover the handoff step
// that opencode does with a tool call and this host cannot do at all.
const EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
  "SessionStart",
]
const TOOL_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure"]

const tempRoots: string[] = []
let home = ""

/** A settings.json shaped like the one this was developed against: a
 * third-party hook on an event we also register, one on an event we do not
 * touch at all, and unrelated top-level keys. Every assertion about "leaves
 * the rest alone" is measured against this. */
function seedSettings(): void {
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.writeFileSync(
    path.join(home, ".claude", "settings.json"),
    `${JSON.stringify(
      {
        model: "opus",
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }],
          SubagentStop: [{ hooks: [{ type: "command", command: "/bin/sh /home/someone/.orca/hook.sh", timeout: 10 }] }],
        },
        permissions: { allow: ["Bash(ls:*)"] },
      },
      null,
      2,
    )}\n`,
  )
}

function settingsPath(): string {
  return path.join(home, ".claude", "settings.json")
}

function hookPath(): string {
  return path.join(home, ".claude", "token-norm", "hook.mjs")
}

function readSettings(): Record<string, any> {
  return JSON.parse(fs.readFileSync(settingsPath(), "utf8"))
}

function ourEntries(settings: Record<string, any>, event: string): Array<Record<string, any>> {
  const groups = settings.hooks?.[event] ?? []
  return groups.flatMap((group: any) =>
    (group.hooks ?? []).filter((entry: any) => typeof entry.command === "string" && entry.command.includes("token-norm")),
  )
}

function run(args: string[], extraEnv: Record<string, string> = {}): { out: string; code: number } {
  // CLAUDE_CONFIG_DIR is cleared rather than overridden so these cases exercise
  // the ~/.claude default; the one case that wants the override sets it back.
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    ...extraEnv,
  }
  if (!("CLAUDE_CONFIG_DIR" in extraEnv)) delete env.CLAUDE_CONFIG_DIR
  try {
    const out = execFileSync(process.execPath, [script, ...args], { encoding: "utf8", env: env as NodeJS.ProcessEnv })
    return { out, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 }
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "token-norm-claude-"))
  tempRoots.push(home)
})

afterAll(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true })
})

describe("install --host claude", () => {
  it("copies the packaged hook bundle to a stable path", () => {
    const { out, code } = run(["install", "--host", "claude"])
    expect(code).toBe(0)
    expect(out).toContain(hookPath())
    expect(fs.readFileSync(hookPath())).toEqual(fs.readFileSync(packagedBundle))
  })

  it("registers every event the adapter handles, with this host's matcher convention", () => {
    run(["install", "--host", "claude"])
    const settings = readSettings()
    expect(Object.keys(settings.hooks).sort()).toEqual([...EVENTS].sort())
    for (const event of EVENTS) {
      const entries = ourEntries(settings, event)
      expect(entries, event).toHaveLength(1)
      expect(entries[0]).toEqual({ type: "command", command: `node ${JSON.stringify(hookPath())}`, timeout: 10 })
    }
    for (const event of TOOL_EVENTS) {
      expect(settings.hooks[event].at(-1).matcher, event).toBe("*")
    }
    for (const event of EVENTS.filter((e) => !TOOL_EVENTS.includes(e))) {
      expect(settings.hooks[event].at(-1), event).not.toHaveProperty("matcher")
    }
  })

  it("merges into third-party hooks instead of overwriting them", () => {
    seedSettings()
    run(["install", "--host", "claude"])
    const settings = readSettings()

    // The rtk group survives untouched, ours is added beside it.
    expect(settings.hooks.PreToolUse[0]).toEqual({
      matcher: "Bash",
      hooks: [{ type: "command", command: "rtk hook claude" }],
    })
    expect(settings.hooks.PreToolUse).toHaveLength(2)

    // An event we never register is left exactly as it was.
    expect(settings.hooks.SubagentStop).toEqual([
      { hooks: [{ type: "command", command: "/bin/sh /home/someone/.orca/hook.sh", timeout: 10 }] },
    ])

    // ...and so is everything outside "hooks".
    expect(settings.model).toBe("opus")
    expect(settings.permissions).toEqual({ allow: ["Bash(ls:*)"] })
  })

  it("is idempotent: a second install adds no duplicate entry", () => {
    seedSettings()
    run(["install", "--host", "claude"])
    const first = readSettings()
    run(["install", "--host", "claude"])
    const second = readSettings()
    expect(second).toEqual(first)
    for (const event of EVENTS) expect(ourEntries(second, event), event).toHaveLength(1)
  })

  it("accepts --host=claude as well as --host claude, without reading the value as a command", () => {
    const { out, code } = run(["--host=claude"])
    expect(code).toBe(0)
    expect(out).toContain("installed hook")
    expect(fs.existsSync(hookPath())).toBe(true)
  })

  it("honours CLAUDE_CONFIG_DIR when the user has set one", () => {
    const dir = path.join(home, "elsewhere")
    run(["install", "--host", "claude"], { CLAUDE_CONFIG_DIR: dir })
    expect(fs.existsSync(path.join(dir, "token-norm", "hook.mjs"))).toBe(true)
    expect(fs.existsSync(path.join(dir, "settings.json"))).toBe(true)
    expect(fs.existsSync(settingsPath())).toBe(false)
  })

  it("rejects an unknown host", () => {
    const { out, code } = run(["install", "--host", "codex"])
    expect(code).toBe(1)
    expect(out).toContain('unknown host "codex"')
    expect(fs.existsSync(path.join(home, ".claude"))).toBe(false)
  })

  it("refuses to write a settings.json it cannot parse, and changes nothing", () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
    const broken = '{ "hooks": { /* a comment makes this JSONC, not JSON */ } }'
    fs.writeFileSync(settingsPath(), broken)

    const { out, code } = run(["install", "--host", "claude"])
    expect(code).toBe(1)
    expect(out).toContain("not valid JSON")
    expect(out).toContain("refusing to write it")
    expect(fs.readFileSync(settingsPath(), "utf8")).toBe(broken)
  })
})

describe("install --host claude --dry-run", () => {
  it("names the hook path, the settings file and every event, and writes nothing", () => {
    seedSettings()
    const before = fs.readFileSync(settingsPath(), "utf8")

    const { out, code } = run(["install", "--host", "claude", "--dry-run"])
    expect(code).toBe(0)
    expect(out).toContain(hookPath())
    expect(out).toContain(settingsPath())
    for (const event of EVENTS) expect(out, event).toContain(event)
    expect(out).toContain("--dry-run: nothing was written.")

    expect(fs.readFileSync(settingsPath(), "utf8")).toBe(before)
    expect(fs.existsSync(hookPath())).toBe(false)
  })

  it("distinguishes an event it would register from one already registered", () => {
    run(["install", "--host", "claude"])
    const { out } = run(["install", "--host", "claude", "--dry-run"])
    expect(out).toContain("already registered")
    expect(out).not.toMatch(/^\s+register\s/m)
  })
})

describe("uninstall --host claude", () => {
  it("removes our hook file and our entries, and nothing else", () => {
    seedSettings()
    run(["install", "--host", "claude"])
    const { out, code } = run(["uninstall", "--host", "claude"])
    expect(code).toBe(0)
    expect(out).toContain("unregistered")

    expect(fs.existsSync(hookPath())).toBe(false)
    expect(fs.existsSync(path.join(home, ".claude", "token-norm"))).toBe(false)

    const settings = readSettings()
    for (const event of EVENTS) expect(ourEntries(settings, event), event).toHaveLength(0)

    // The third-party hook keeps its event; the events that existed only for
    // our hook are pruned rather than left as empty arrays.
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] },
    ])
    expect(settings.hooks).not.toHaveProperty("SessionEnd")
    expect(settings.hooks).not.toHaveProperty("Stop")
    expect(settings.hooks.SubagentStop).toHaveLength(1)
    expect(settings.model).toBe("opus")
  })

  it("previews an uninstall without removing anything", () => {
    run(["install", "--host", "claude"])
    const before = fs.readFileSync(settingsPath(), "utf8")
    const { out } = run(["uninstall", "--host", "claude", "--dry-run"])
    expect(out).toContain("--dry-run: nothing was removed.")
    expect(fs.readFileSync(settingsPath(), "utf8")).toBe(before)
    expect(fs.existsSync(hookPath())).toBe(true)
  })

  it("reports an absent install without failing", () => {
    const { out, code } = run(["uninstall", "--host", "claude"])
    expect(code).toBe(0)
    expect(out).not.toContain("unregistered")
  })
})

describe("doctor --host claude", () => {
  it("fails when the hook is not installed", () => {
    const { out, code } = run(["doctor", "--host", "claude"])
    expect(code).toBe(1)
    expect(out).toContain("hook installed")
    expect(out).toContain("Status: not working")
  })

  it("fails when the hook file is installed but never registered", () => {
    run(["install", "--host", "claude"])
    const settings = readSettings()
    delete settings.hooks
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))

    const { out, code } = run(["doctor", "--host", "claude"])
    expect(code).toBe(1)
    expect(out).toContain("no token-norm hooks")
  })

  it("warns, without failing, when only some events are registered", () => {
    run(["install", "--host", "claude"])
    const settings = readSettings()
    delete settings.hooks.SessionEnd
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))

    const { out, code } = run(["doctor", "--host", "claude"])
    expect(code).toBe(0)
    expect(out).toContain("not registered for SessionEnd")
  })

  it("passes on a fresh install and reports the axes this host degrades", () => {
    run(["install", "--host", "claude"])
    const { out, code } = run(["doctor", "--host", "claude"])
    expect(code).toBe(0)
    expect(out).toContain("matches this package")
    expect(out).toContain(`all ${EVENTS.length} events`)
    expect(out).toContain("cost axis")
    expect(out).toContain("context axis")
    expect(out).toContain("Status: ready")
  })

  it("reports the context axis as on when TOKEN_NORM_CONTEXT_LIMIT is set", () => {
    run(["install", "--host", "claude"])
    const { out } = run(["doctor", "--host", "claude"], { TOKEN_NORM_CONTEXT_LIMIT: "200000" })
    expect(out).toContain("TOKEN_NORM_CONTEXT_LIMIT=200000")
  })

  it("warns when the installed hook is stale, without failing", () => {
    run(["install", "--host", "claude"])
    fs.writeFileSync(hookPath(), "// an older version\n")
    const { out, code } = run(["doctor", "--host", "claude"])
    expect(code).toBe(0)
    expect(out).toContain("differs from this package")
  })
})
