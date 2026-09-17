import fs from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  const base = process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"
  const sep = base.endsWith("/") ? "" : "/"
  process.env.TOKEN_NORM_HANDOFF_DIR = `${base}${sep}token-norm-handoff-test-${process.pid}`
  process.env.TOKEN_NORM_SETTLE_MS = "10"
  process.env.TOKEN_NORM_SWITCH_WAIT_MS = "10"
  process.env.TOKEN_NORM_LOG = `${base}${sep}token-norm-handoff-test-${process.pid}.log`
})

vi.mock("../src/core/log.js", () => ({ log: vi.fn(), logConfigDiagnostics: vi.fn(() => []) }))

import { HandoffPlugin } from "../src/handoff.js"
import { log } from "../src/core/log.js"

const DIR = process.env.TOKEN_NORM_HANDOFF_DIR!

beforeEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true })
})

function fakeClient(agents: () => Promise<any>) {
  let filesAtSwitch = -1
  return {
    client: {
      app: { agents: vi.fn(agents) },
      tui: {
        executeCommand: vi.fn(async () => {
          filesAtSwitch = fs.existsSync(DIR) ? fs.readdirSync(DIR).length : 0
        }),
        appendPrompt: vi.fn(async (_input?: any) => {}),
        submitPrompt: vi.fn(async () => {}),
        showToast: vi.fn(async () => {}),
      },
    },
    filesAtSwitch: () => filesAtSwitch,
  }
}

function ctx(agent = "build") {
  return {
    sessionID: "ses_handoff_test",
    messageID: "msg_1",
    agent,
    directory: "/repo",
    worktree: "/repo",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

async function loadHooks(client: unknown) {
  return HandoffPlugin({ client, directory: "/repo" } as never)
}

async function load(client: unknown) {
  const hooks = await loadHooks(client)
  return hooks.tool!.handoff
}

const args = { task: "Fix expiry", done: "Diagnosed", next: "Patch" }

describe("handoff tool", () => {
  it("refuses subagents: no file, no TUI switch", async () => {
    const { client } = fakeClient(async () => ({ data: [{ name: "explore", mode: "subagent" }] }))
    const handoff = await load(client)
    const result = (await handoff.execute(args, ctx("explore"))) as any

    expect(result.metadata.refused).toBe("subagent")
    expect(client.tui.executeCommand).not.toHaveBeenCalled()
    expect(fs.existsSync(DIR)).toBe(false)
  })

  it("allows the call when the agent lookup fails", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("server unreachable")
    })
    const handoff = await load(client)
    const result = (await handoff.execute({ ...args, submit: false }, ctx())) as any

    expect(result.metadata.notePath).toBeTruthy()
    expect(client.tui.executeCommand).toHaveBeenCalledWith({ body: { command: "session_new" } })
  })

  it("persists the note before switching, then pre-fills and submits", async () => {
    const { client, filesAtSwitch } = fakeClient(async () => ({ data: [] }))
    const handoff = await load(client)
    const result = (await handoff.execute(
      {
        task: "Fix token expiry",
        done: "Diagnosed at /repo/src/auth/token.ts:88",
        next: "Change < to <=",
        files: ["/repo/src/auth/token.ts:88"],
        notes: "avoid clock skew",
      },
      ctx(),
    )) as any

    expect(filesAtSwitch()).toBe(1)
    expect(client.tui.submitPrompt).toHaveBeenCalledTimes(1)

    const note = fs.readFileSync(result.metadata.notePath, "utf8")
    expect(note).toContain("**Task:** Fix token expiry")
    expect(note).toContain("**Done:** Diagnosed at /repo/src/auth/token.ts:88")
    expect(note).toContain("**Next:** Change < to <=")
    expect(note).toContain("- /repo/src/auth/token.ts:88")
    expect(note).toContain("**Notes:**\navoid clock skew")
    expect(note).toContain("ses_handoff_test")

    const appended = client.tui.appendPrompt.mock.calls[0][0] as any
    expect(appended.body.text).toContain(result.metadata.notePath)
  })

  it("keeps the persisted note when the TUI switch fails", async () => {
    const { client } = fakeClient(async () => ({ data: [] }))
    client.tui.executeCommand.mockRejectedValueOnce(new Error("tui gone"))
    const handoff = await load(client)

    await expect(handoff.execute(args, ctx())).rejects.toThrow("tui gone")
    expect(fs.readdirSync(DIR)).toHaveLength(1)
  })

  it("disarms the failed switch: a late event cannot satisfy the retry", async () => {
    const { client } = fakeClient(async () => ({ data: [] }))
    const hooks = await loadHooks(client)
    vi.mocked(log).mockClear()

    client.tui.executeCommand.mockRejectedValueOnce(new Error("tui gone"))
    await expect(hooks.tool!.handoff.execute(args, ctx())).rejects.toThrow("tui gone")

    // The TUI may have dispatched the new session before throwing; that late
    // event must not be mistaken for the next handoff's own session.
    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "ses_dead_switch", time: { created: Date.now() } } },
      },
    } as never)

    // Retry: executeCommand succeeds but emits nothing, so the handoff must
    // fall back to its own bounded timeout and append its own note.
    const result = (await hooks.tool!.handoff.execute(args, ctx())) as any
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no session.created"))
    expect(client.tui.appendPrompt).toHaveBeenCalledTimes(1)
    const appended = client.tui.appendPrompt.mock.calls[0][0] as any
    expect(appended.body.text).toContain(result.metadata.notePath)
    expect(fs.readdirSync(DIR)).toHaveLength(2)
  })

  it("waits for the session.created event before appending the prompt", async () => {
    const { client } = fakeClient(async () => ({ data: [] }))
    const hooks = await loadHooks(client)
    const order: string[] = []

    client.tui.executeCommand.mockImplementation(async () => {
      order.push("session_new")
      await hooks.event!({
        event: {
          type: "session.created",
          properties: { info: { id: "ses_new", time: { created: Date.now() } } },
        },
      } as never)
      order.push("created-event")
    })
    client.tui.appendPrompt.mockImplementation(async () => {
      order.push("append")
    })

    await hooks.tool!.handoff.execute(args, ctx())
    expect(order).toEqual(["session_new", "created-event", "append"])
  })

  it("ignores a late session.created from a previous timed-out switch", async () => {
    const { client } = fakeClient(async () => ({ data: [] }))
    const hooks = await loadHooks(client)
    vi.mocked(log).mockClear()

    client.tui.executeCommand.mockImplementation(async () => {
      await hooks.event!({
        event: {
          type: "session.created",
          properties: { info: { id: "ses_stale", time: { created: Date.now() - 60_000 } } },
        },
      } as never)
    })

    await hooks.tool!.handoff.execute(args, ctx())
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no session.created"))
  })

  it("ignores a session.created without time.created (unverifiable freshness)", async () => {
    const { client } = fakeClient(async () => ({ data: [] }))
    const hooks = await loadHooks(client)
    vi.mocked(log).mockClear()

    client.tui.executeCommand.mockImplementation(async () => {
      await hooks.event!({
        event: {
          type: "session.created",
          properties: { info: { id: "ses_no_time" } },
        },
      } as never)
    })

    await hooks.tool!.handoff.execute(args, ctx())
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no session.created"))
    expect(client.tui.appendPrompt).toHaveBeenCalledTimes(1)
  })

  it("does not overwrite when two handoffs happen in the same second", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      const { client } = fakeClient(async () => ({ data: [] }))
      const handoff = await load(client)
      const first = (await handoff.execute(args, ctx())) as any
      const second = (await handoff.execute(args, ctx())) as any

      expect(first.metadata.notePath).not.toBe(second.metadata.notePath)
      expect(fs.readdirSync(DIR)).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it.skipIf(process.platform === "win32")("writes the directory 0700 and the note 0600", async () => {
    const { client } = fakeClient(async () => ({ data: [] }))
    const handoff = await load(client)
    const result = (await handoff.execute(args, ctx())) as any

    expect(fs.statSync(DIR).mode & 0o777).toBe(0o700)
    expect(fs.statSync(result.metadata.notePath).mode & 0o777).toBe(0o600)
  })

  it("submit: false stops at the pre-filled prompt", async () => {
    const { client } = fakeClient(async () => ({ data: [] }))
    const handoff = await load(client)
    const result = (await handoff.execute({ ...args, submit: false }, ctx())) as any

    expect(client.tui.submitPrompt).not.toHaveBeenCalled()
    expect(result.metadata.submitted).toBe(false)
    expect(client.tui.appendPrompt).toHaveBeenCalledTimes(1)
  })

  it("ignores session.created for a child session (subagent spawn, not the switch)", async () => {
    const { client } = fakeClient(async () => ({ data: [] }))
    const hooks = await loadHooks(client)
    vi.mocked(log).mockClear()

    client.tui.executeCommand.mockImplementation(async () => {
      await hooks.event!({
        event: {
          type: "session.created",
          properties: { info: { id: "ses_child", parentID: "ses_parent", time: { created: Date.now() } } },
        },
      } as never)
    })

    await hooks.tool!.handoff.execute(args, ctx())
    // A parented session is not evidence the TUI switched, so the wait must
    // run out and the prompt land only after the bounded fallback.
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no session.created"))
    expect(client.tui.appendPrompt).toHaveBeenCalledTimes(1)
  })

  it("accepts session.created that arrives after executeCommand returns", async () => {
    const { client } = fakeClient(async () => ({ data: [] }))
    const hooks = await loadHooks(client)
    vi.mocked(log).mockClear()

    // The TUI dispatches the command and returns; the event lands on a later
    // tick, still inside SWITCH_WAIT_MS. That is the normal production shape.
    client.tui.executeCommand.mockImplementation(async () => {
      setTimeout(() => {
        void hooks.event!({
          event: {
            type: "session.created",
            properties: { info: { id: "ses_late_ok", time: { created: Date.now() } } },
          },
        } as never)
      }, 0)
    })

    await hooks.tool!.handoff.execute(args, ctx())
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("no session.created"))
    expect(client.tui.appendPrompt).toHaveBeenCalledTimes(1)
  })

  it("holds the settle floor even when the event resolves immediately", async () => {
    const { client } = fakeClient(async () => ({ data: [] }))
    const hooks = await loadHooks(client)

    let switchedAt = 0
    let appendedAt = 0
    client.tui.executeCommand.mockImplementation(async () => {
      switchedAt = Date.now()
      await hooks.event!({
        event: {
          type: "session.created",
          properties: { info: { id: "ses_fast", time: { created: Date.now() } } },
        },
      } as never)
    })
    client.tui.appendPrompt.mockImplementation(async () => {
      appendedAt = Date.now()
    })

    await hooks.tool!.handoff.execute(args, ctx())
    // The event resolved the wait on the same tick, so the only thing that can
    // separate the switch from the append is the settle floor. Timer granularity
    // can report one millisecond short of the sleep, hence the -1 slack.
    const floor = Number(process.env.TOKEN_NORM_SETTLE_MS)
    expect(appendedAt - switchedAt).toBeGreaterThanOrEqual(floor - 1)
  })

  it("keeps the persisted note when appendPrompt throws, and disarms the waiter", async () => {
    const { client } = fakeClient(async () => ({ data: [] }))
    const hooks = await loadHooks(client)
    client.tui.appendPrompt.mockRejectedValueOnce(new Error("prompt gone"))

    await expect(hooks.tool!.handoff.execute(args, ctx())).rejects.toThrow("prompt gone")
    expect(fs.readdirSync(DIR)).toHaveLength(1)
    expect(client.tui.submitPrompt).not.toHaveBeenCalled()

    // The waiter is cleared before the append, so a late event from the failed
    // handoff cannot satisfy the retry's wait.
    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "ses_orphan", time: { created: Date.now() } } },
      },
    } as never)
    vi.mocked(log).mockClear()
    await hooks.tool!.handoff.execute(args, ctx())
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no session.created"))
    expect(fs.readdirSync(DIR)).toHaveLength(2)
  })

  it("keeps the note and the appended prompt when submitPrompt throws", async () => {
    const { client } = fakeClient(async () => ({ data: [] }))
    const handoff = await load(client)
    client.tui.submitPrompt.mockRejectedValueOnce(new Error("submit gone"))

    await expect(handoff.execute(args, ctx())).rejects.toThrow("submit gone")
    // The user is left with a filled prompt they can send by hand; the note
    // survives either way.
    expect(client.tui.appendPrompt).toHaveBeenCalledTimes(1)
    expect(fs.readdirSync(DIR)).toHaveLength(1)
    expect(client.tui.showToast).not.toHaveBeenCalled()
  })

  it("two overlapping handoffs each write their own note and their own prompt", async () => {
    const { client } = fakeClient(async () => ({ data: [] }))
    const hooks = await loadHooks(client)

    const [first, second] = (await Promise.all([
      hooks.tool!.handoff.execute({ ...args, task: "first" }, ctx()),
      hooks.tool!.handoff.execute({ ...args, task: "second" }, ctx()),
    ])) as any[]

    expect(first.metadata.notePath).not.toBe(second.metadata.notePath)
    expect(fs.readdirSync(DIR)).toHaveLength(2)
    expect(client.tui.appendPrompt).toHaveBeenCalledTimes(2)
    const texts = client.tui.appendPrompt.mock.calls.map((c: any[]) => c[0].body.text)
    expect(texts.some((t: string) => t.includes(first.metadata.notePath))).toBe(true)
    expect(texts.some((t: string) => t.includes(second.metadata.notePath))).toBe(true)
  })
})
