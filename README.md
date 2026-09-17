# opencode-token-norm

[![npm version](https://img.shields.io/npm/v/opencode-token-norm)](https://www.npmjs.com/package/opencode-token-norm)
[![npm downloads](https://img.shields.io/npm/dm/opencode-token-norm)](https://www.npmjs.com/package/opencode-token-norm)
[![test](https://github.com/salitaba/opencode-token-norm/actions/workflows/test.yml/badge.svg)](https://github.com/salitaba/opencode-token-norm/actions/workflows/test.yml)
[![license](https://img.shields.io/npm/l/opencode-token-norm)](https://github.com/salitaba/opencode-token-norm/blob/main/LICENSE)

### Your token rules are advice. This makes them mechanical.

Runtime guardrails for [OpenCode](https://opencode.ai) coding agents. A long
session drifts: a new task inherits the last one's "do everything" override, the
audit you told it to run never happens, and you find out at 184 tool calls.
Token Norm counts the spend and staples the checkpoint onto output the agent is
already reading.

```sh
npx opencode-token-norm
```

![token-norm demo: the agent gets counted, audited, and handed off](https://raw.githubusercontent.com/salitaba/opencode-token-norm/main/docs/assets/token-norm-demo.gif)

*([full-speed demo MP4](https://raw.githubusercontent.com/salitaba/opencode-token-norm/main/docs/assets/token-norm-demo.mp4))*

## What you get

- **Cost statement at 25 calls** — once per session, before the bulk of the spend.
- **Task-boundary detection at 40** — a new user message revokes the stale
  "do everything" override it would otherwise inherit.
- **The audit run for you every 60 calls** — read-only, numbers stapled on, no
  command left for the agent to defer.
- **One-call session handoff** — persists a structured note, opens a fresh
  session, pre-fills and submits the prompt.
- **Context, cost and token pressure** — measured against the real model window;
  never guessed when it cannot be resolved.
- **`token_norm_status`** — the same accounting on demand, as machine-readable JSON.

```text
Without Token Norm          With Token Norm
  task A                      task A
    ↓ 184 tool calls            ↓ 25 calls  ⚠ cost checkpoint
    ↓ task B inherits           ↓ 40 calls  ⚠ task boundary: override expired
      A's override              ↓ 60 calls  ⚠ audit, already run
    ↓                           ↓           🧭 handoff at the pause
  3.0M effective tokens       task B in a fresh session
```

## Enforcement modes

An adoption ladder, not a switch. `TOKEN_NORM_MODE`, default `handoff`:

| Mode | What it does |
|---|---|
| `observe` | Measures and logs. Injects nothing. |
| `warn` | Injects the checkpoint into tool output. |
| `handoff` | Adds a session-split recommendation, but only at a pause. **Default.** |
| `block` | Refuses non-cheap tool calls past a hard limit. Opt-in. |

Only `block` can fail a tool call, and only on a limit you set — pressure alone
never strands a session. Cheap tools and `handoff` stay open as the exit.

## Install

```sh
npx opencode-token-norm
```

Restart OpenCode. The command copies a self-contained build into
`~/.config/opencode/plugins/` and the audit script into
`~/.config/opencode/scripts/` — nothing outside `~/.config/opencode` is touched.
Two commands make that checkable rather than trusted:

```sh
npx opencode-token-norm --dry-run   # every path it would write, writes nothing
npx opencode-token-norm doctor      # is it installed, current, and configured?
```

`doctor` exits non-zero only when the plugin is not working; a missing `python3`
is a warning, because audits are optional and nothing else depends on it. It also
hashes the installed file against the one in the package, which is the only way to
tell a current install from a stale copy. Uninstall with
`npx opencode-token-norm uninstall`. Requires Node ≥ 22 and an OpenCode build with
plugin support. Requirements, verification, and troubleshooting are in the
[install notes](https://github.com/salitaba/opencode-token-norm/blob/main/docs/install.md).

| Node | OpenCode | `@opencode-ai/plugin` | Token Norm |
|---|---|---|---|
| ≥ 22 | V1 plugin API, verified on 1.18.30 | ≥ 1.15.12 | 0.10.x |

The V2 plugin API is not targeted yet. Verified builds, per-release, are in the
[compatibility notes](https://github.com/salitaba/opencode-token-norm/blob/main/docs/compatibility.md).

## Install on Claude Code

```sh
npx opencode-token-norm install --host claude
npx opencode-token-norm doctor  --host claude
```

The norm runs as hooks rather than as a plugin. The command copies a
self-contained build to `~/.claude/token-norm/hook.mjs` and registers it for
seven events in `~/.claude/settings.json`. That file is yours and other tools
write to it, so the merge is additive: entries are identified by the installed
hook path, an install that finds its own entry rewrites it in place rather than
duplicating it, `uninstall --host claude` removes only what it added, and a
`settings.json` that does not parse is refused rather than rewritten. Use
`--dry-run` on either write path to see the plan first.

Verified against Claude Code 2.1.274, which picks the hooks up without a
restart — including in sessions that are already running.

**Two axes are off on this host, and say so rather than reporting zero.** A
Claude transcript records token counts but no prices, so the cost axis is
inert and `TOKEN_NORM_MAX_COST` does nothing. Nothing in the transcript gives a
context window size either, so the context axis stays disabled until you set
`TOKEN_NORM_CONTEXT_LIMIT` — this project does not guess a limit, because a
guessed one is indistinguishable from a measured one once it is on screen.
`doctor` reports both as warnings, since a missing axis at runtime looks exactly
like an axis that is fine.

**The handoff is two steps here, not one.** On OpenCode the `handoff` tool
writes the note and opens the new session with the note as its first prompt. No
host API can start a Claude Code session, and a hook certainly cannot, so the
split becomes: the agent writes the note to
`~/.local/share/opencode/handoff/notes/<project>/handoff.md` — the path is named
in the reminder — and you run `/clear`. The new session's `SessionStart` hook
injects that note and marks it consumed, so it arrives exactly once, only in the
project it was written for, and only into a session that started empty
(`clear` or `startup`; a `resume`, `fork` or `compact` already holds the context
the note describes).

## Why add Token Norm?

| Capability | Statusline / dashboard | Token rule in `AGENTS.md` | token-norm |
|---|---|---|---|
| Who reads it | you, at the edge of the screen | the model, as one more instruction | the model, stapled to output it is already reading |
| When it fires | live, but outside the agent's context | only if the agent chooses to reread it | at 25 / 40 / 60 calls, in-band |
| Audit checkpoint | you run it, or you don't | "run the audit periodically" | already run — read-only, every 60 calls |
| Stale "do everything" overrides | invisible | nothing revokes them | a new task past 40 calls expires them |
| Session split | out-of-band, three manual steps | "split at phase boundaries" | one `handoff` call, fresh session pre-filled |
| Can block a tool call | no | no | no, unless opt-in `block` mode |

**Soft enforcement, stated plainly.** By default the plugin never blocks a tool
call, edits its arguments, or fails one — it changes what the agent can't miss,
not what it can do. Only opt-in `block` mode refuses non-cheap tool calls while
over budget. A determined agent can still ignore every reminder. The bet is that the
numbers arriving in-band, at the moment of spend, change the plan; if the bet
fails, you still get the honest receipt.

None of this replaces the others: `AGENTS.md` still defines what "on budget"
means, and a dashboard is still the passive record — this is the runtime layer
between them. It was built against a concrete failure: a token budget written
into `AGENTS.md`, in context for the whole session, and then 184 tool calls and
3.0M effective fresh tokens spent on a task that should have been three sessions
([call by call](https://github.com/salitaba/opencode-token-norm/blob/main/docs/post-mortem.md)).

## How it works

```text
                   OpenCode
                      │
          ┌───────────┴────────────┐
          │                        │
   session-budget             handoff
          │                        │
   tool.execute.after       handoff(...)
   message.updated                │
   session.compacting             ├─ persist note to disk
          │                       ├─ open a fresh session
          ├─ count budgeted calls ├─ pre-fill the prompt
          ├─ boundary / announce  └─ submit it
          ├─ run the audit
          └─ staple a reminder
             onto tool output
                      │
             the agent reads it in-band
```

- **Task boundary detection.** Past `BOUNDARY_AT` calls (default 40), a new user
  message revokes any stale "do everything" override, and the next tool call
  carries the reminder — once per user message, keyed on identity.
  [why](https://github.com/salitaba/opencode-token-norm/blob/main/docs/design.md#task-boundary-detection)
- **Cost statement at 25 calls.** Once per session, the plugin demands the
  remaining calls, the caps now in effect, and which slice could ship immediately
  behind a handoff.
  [why 25](https://github.com/salitaba/opencode-token-norm/blob/main/docs/design.md#why-25-and-why-once-per-session)
- **Audit checkpoint every 60 calls.** The plugin runs the audit itself —
  read-only against OpenCode's sqlite DB — and staples the numbers to output the
  agent is already reading.
  [the metric](https://github.com/salitaba/opencode-token-norm/blob/main/docs/design.md#the-effective-fresh-metric)
- **Compaction context.** Compaction is the one moment an agent provably re-reads
  its own rules, so the plugin injects the call count into it.
- **The `handoff` tool.** Persists the note before the TUI switch, opens a fresh
  session, pre-fills and submits the prompt; refused for subagents.
  [design decisions](https://github.com/salitaba/opencode-token-norm/blob/main/docs/design.md#handoff-design-decisions)
- **On-demand status.** `token_norm_status` returns tool calls, context, cost and
  effective-token usage plus `policy.current` (severity now), `policy.peak`
  (severity ever), `policy.driver` (which axis) and the
  `continue | warn | handoff | block` recommendation, as read-only JSON. The
  payload is a **public interface**: stable field names within a major version,
  `peak` never below `current`, and reading it never changes it.
  [payload and fields](https://github.com/salitaba/opencode-token-norm/blob/main/docs/how-it-works.md#the-payload)

**Two call counts, on purpose.** Raw per-session calls drive the behavioral
checkpoints (25 / 40 / 60); weighted session-tree calls drive
`TOKEN_NORM_MAX_TOOL_CALLS` and `budget.toolCalls`. So a header reading
`calls 37` next to `budget.toolCalls: 52` is correct, not a bug — subagents
count toward the tree, and weights scale the budget number only, never the
thresholds.
[weighted vs. raw](https://github.com/salitaba/opencode-token-norm/blob/main/docs/how-it-works.md#weighted-vs-raw-calls)

**Process-local by design.** Counters live in memory, not on disk: restarting
OpenCode resets runtime enforcement state, and the guardrails then undercount
rather than re-firing on spend already made. The limits are not durable session
policy.
[why](https://github.com/salitaba/opencode-token-norm/blob/main/docs/design.md#session-state-and-process-boundaries)

Full mechanism descriptions, with the exact reminder text and audit output:
[how it works](https://github.com/salitaba/opencode-token-norm/blob/main/docs/how-it-works.md).

## Evidence

Kept in three separate buckets, because they carry very different weight:

**Observed in real usage.** On one machine since 2026-09-08: 205 sessions, 227
cost-statement reminders, 69 audits, 583 boundaries, 74 handoffs. After a
handoff, **64 of 71 (90%)** matched sessions stopped within 5 minutes (median 4
seconds), and **none continued past an hour**. Single user, no control group.

**Benchmark result.** n=20 per arm. Plugin load costs
**0.158 s → 0.278 s**; the wall-time difference is **+2.6 s, p = 0.83** — i.e.
not distinguishable from noise. An earlier run reported a wall-time effect; that
was a harness artifact and the finding was retracted rather than kept.

**Hypothesis, not yet demonstrated.** That the checkpoints reduce total spend.
The behavioral data above is consistent with it and does not establish it —
**we do not claim the plugin reduced tokens.** Method, protocol and limitations:
[evaluation notes](https://github.com/salitaba/opencode-token-norm/blob/main/docs/evaluation.md)
· [benchmark](https://github.com/salitaba/opencode-token-norm/blob/main/docs/benchmark.md).

> **`effective fresh tokens` ≠ total tokens the model processed.** It is
> cost-weighted input — `input + 0.1·cache_read + 1.25·cache_write` — which
> estimates newly-paid-for context, so sessions are comparable across cache hit
> rates. Do not expect it to match a provider dashboard's token total.
> [the metric](https://github.com/salitaba/opencode-token-norm/blob/main/docs/design.md#the-effective-fresh-metric)

## Configuration

All optional, all environment variables. Three thresholds —
`TOKEN_NORM_ANNOUNCE_AT`, `TOKEN_NORM_AUDIT_EVERY`, `TOKEN_NORM_BOUNDARY_AT` —
plus two kill switches: `TOKEN_NORM_BUDGET=0` disables the counting half, and
`TOKEN_NORM_HANDOFF=0` drops the `handoff` tool. The guardrails — thresholds
and mode — are on by default; the measured budgets (`TOKEN_NORM_MAX_COST`,
`TOKEN_NORM_MAX_EFFECTIVE_TOKENS`, `TOKEN_NORM_MAX_TOOL_CALLS`,
`TOKEN_NORM_CONTEXT_WARN`, `TOKEN_NORM_CONTEXT_LIMIT`) are opt-in, and unset
means unenforced. All options and defaults:
[configuration](https://github.com/salitaba/opencode-token-norm/blob/main/docs/configuration.md).

## Run the audit yourself

The audit script ships inside the package and reads the same DB the plugin does:

```sh
python3 node_modules/opencode-token-norm/scripts/usage-audit.py --last
```

Modes `--session`, `--top` and `--receipt` (each accepts `--json`), the
paste-ready receipt, and the `effective fresh tokens` formula are in the
[audit notes](https://github.com/salitaba/opencode-token-norm/blob/main/docs/audit.md).

## Pairs with your `AGENTS.md`

This plugin replaces none of your rules. It makes three of them unskippable and
leaves the rest to you — read windows, smallest test target, subagent delegation,
output caps. A counter cannot know any of those. The reminders are written to
point back at the file that does.

## Further reading

- [**Design notes**](https://github.com/salitaba/opencode-token-norm/blob/main/docs/design.md)
  — why the thresholds are where they are, the task-boundary model, the handoff
  decisions, session-state and safety boundaries, and what the effective-fresh
  number actually measures.
- [**Advice vs. enforcement**](https://github.com/salitaba/opencode-token-norm/blob/main/docs/advice-vs-enforcement.md)
  — the rule-by-rule case for why a norm sitting in context is not a norm, and
  the answer to "isn't this just prompt engineering?"
- [**Post-mortem**](https://github.com/salitaba/opencode-token-norm/blob/main/docs/post-mortem.md)
  — the session that audited itself, reported 3.0M tokens of waste, and kept
  going anyway. Every threshold here traces back to a specific moment in it.

## Links

- [Source](https://github.com/salitaba/opencode-token-norm) · [Issues](https://github.com/salitaba/opencode-token-norm/issues) · [npm](https://www.npmjs.com/package/opencode-token-norm)
- [Changelog](https://github.com/salitaba/opencode-token-norm/blob/main/CHANGELOG.md) · [Contributing](https://github.com/salitaba/opencode-token-norm/blob/main/CONTRIBUTING.md) · [Security](https://github.com/salitaba/opencode-token-norm/blob/main/SECURITY.md)
- If this plugin saved you tokens, a star helps others find it.

## License

MIT
