# Compatibility

Per-host, because a build that passes on one host says nothing about another.
OpenCode is the reference host and has the deepest coverage; Claude Code is
verified through a separate hooks adapter; Codex has no installer and therefore
no row here. The unit suite mocks the runtime that matters most — event
lifecycle, TUI switching, sqlite, Python audit — so real-runtime behavior is
tracked in this file. Run [the manual smoke test](smoke-test.md) against a build
before a release and add one row per run; rows record what actually ran, and a
partial run says which sections were not exercised.

## OpenCode

Targets the V1 plugin API (`@opencode-ai/plugin` ≥ 1.15.12); the V2 plugin API
is not targeted yet.

| OpenCode build | OS | Node | Result | Date | Notes |
|---|---|---|---|---|---|
| 1.18.30 | Linux | 24 | pass | 2026-09-11 | Live sessions on plugin 0.5.0: announce @25, task-boundary @40 with one reminder per user-message id, audit @60, handoff note written before the TUI switch and the 2s `no session.created` fallback appended. Not exercised in this run: block/observe modes (§8), subagent refusal (§6), compaction context (§7). |
| 1.18.30 | Linux | 24 | pass (partial) | 2026-09-11 | Plugin 0.5.2 built fresh from e302b47 (pre-bump HEAD, the code 0.5.2 ships; bundle sha256 `3c5c6b65c455…`; the installed bundle predated `8e3340a` — no `finally` — so it was rebuilt and reinstalled before these runs). Twelve `opencode run` invocations (headless, scratch dir, real `9router/ocg/deepseek-v4-flash`; four via `run --attach` to two `opencode serve` processes for the pause-driven paths): §1 — `announce-threshold at 3 calls`; §2 — the 3-call reminder carried the cost-statement demand; §3 — 2 calls then a new user message: 0 boundaries in message 1, exactly one `This is a TASK BOUNDARY.` on message 2's first tool call, none on its second; §4 — audit table at 3 calls, and with `TOKEN_NORM_PYTHON=definitely-missing` the `usage-audit did not run` fallback printed the manual command and the session continued; §8 observe — `budget crossing at 4 calls: tool-calls 4/3` logged with zero `TOKEN NORM -- BUDGET` injected; §8 block — 4th non-cheap call refused with `TOKEN NORM block (mode=block): Tool calls 3 / 3.`, `todowrite` and `handoff` allowed (note written, then the bounded 2s `no session.created` fallback); §8 handoff mode — `handoff armed (pause + budget pressure)` after idle, then `TOKEN NORM -- HANDOFF RECOMMENDED` on the next tool call; §6 — subagent `general` refused with `handoff is not available to subagents (you are "general", mode: subagent).`, handoff dir unchanged (84→84); §7 — `POST /session/:id/summarize`, hook text incl. `This session has made 1 tool calls` persisted in the rebuilt summary part; §9 — `TOKEN_NORM_BUDGET=0`: zero reminders and handoff still wrote a note; `TOKEN_NORM_HANDOFF=0`: no handoff tool. Not exercised: §5 only — these processes are headless, so note-before-switch, pre-fill, submit, and the toast need an interactive session on the rebuilt plugin. |
| 1.18.30 | Linux | 24 | pass (partial) | 2026-09-12 | Plugin 0.8.0 (released bundle, sha256 `455e2c600b64…` from 60d4ef36). §8 observe context live check in an isolated HOME/XDG harness (bench/run.mjs layout): `opencode run` on `opencode-go/deepseek-v4-flash` with `TOKEN_NORM_CONTEXT_WARN=0.0001` and `TOKEN_NORM_CONTEXT_LIMIT` unset. Logged `budget crossing at 2 calls: context 8.6k/1.0M` with zero `TOKEN NORM -- BUDGET` injected; the 1.0M limit came from the live provider/model lookup. Crossing `used` 8,631 = `usage-audit.py --session` `first_call_total` = that step's `tokens.total` (diff 0, step reasoning 0). No compaction fired (peak 8.7k of 1.0M), so the crossing compares against the newest step persisted when it evaluated — a step's tokens land after its tool returns, so one tool call can never log a context crossing; the at-compaction identity stays covered by the offline table in smoke-test.md §8. Not exercised on this build: block/handoff modes (§8), subagent refusal (§6), compaction context (§7). |
| _template_ | _Linux_ | _22_ | _pass/fail_ | _YYYY-MM-DD_ | _deviations, issue links_ |

## Claude Code

The port runs as hooks rather than as a plugin, so it has its own adapter and its
own verification. Verified against **Claude Code 2.1.274**, driven live through
the installed bundle at `~/.claude/token-norm/hook.mjs` and a real
`~/.claude/settings.json`.

Confirmed on that run: the hook config is consulted per invocation rather than
cached at startup, so three sessions that were *already running* picked the merge
up within 34 seconds and needed no restart. The `SessionStart` injection behaved
as designed — `source=clear` injected the note, `resume` and `compact` injected
nothing and left the note in place, and a following `startup` injected nothing
*because the `clear` had already consumed it*, which is consume-once
demonstrating itself rather than an exclusion list. Seven events register. The
suite stood at 249 passing from a removed `dist/`.

**Not verified, and it needs one human action:** a real `/clear` in a real
session. The run above drives the installed hook as a process with a synthetic
`source`; only the host can prove it sends `source: "clear"` on an actual
`/clear` and renders what comes back. Until that is done, treat the Claude Code
handoff as verified-in-mechanism, not verified-end-to-end.

Two axes are host-limited rather than broken, and `doctor` reports both as
warnings: the cost axis is inert because a transcript records token counts but no
prices, so `TOKEN_NORM_MAX_COST` does nothing here; and no transcript field gives
a context window size, so the context axis stays disabled until you set
`TOKEN_NORM_CONTEXT_LIMIT`. A guessed limit is indistinguishable from a measured
one once it is on screen, so this project does not guess. The audit checkpoint
does fire, computed from the transcript in-process instead of by shelling out to
`usage-audit.py` (that script reads OpenCode's sqlite DB).

Full port log, step by step: [multi-host-port.md](multi-host-port.md).

## Codex

No rows, and none should be added until there is something to run. The adapter
and its measurement layer are implemented and unit-tested, but the host is absent
from the installer's host list, no Codex bundle is built into the published
package, and no live Codex session has exercised the code. `--host codex` is
rejected. The build order and what remains are tracked in
[multi-host-port.md](multi-host-port.md#9-codex-build-order-steps-10-16).

## Runtime assumptions

- `session.created` is emitted for the new primary (parentless) session, and
  `info.time.created` is a number — required by the V1 `Session` type in
  `@opencode-ai/plugin` ≥ 1.15.12. A `session.created` without a timestamp is
  treated as unverifiable: the waiter ignores it and falls back to the bounded
  timeout (`no session.created` in the log), so a stale event can never resolve
  the wrong switch. If a build ever stops sending the field, handoffs get slower
  but stay correct — record it here.
- `tui.executeCommand("session_new")` returns once the command is dispatched,
  not once the session is mounted, so the plugin waits for the event with a
  settle floor and a 2s fallback (`TOKEN_NORM_SWITCH_WAIT_MS`).
