# Configuration

*All optional, all environment variables, and the defaults are the ones real
sessions argued for — [the design notes](design.md) explain why.*

The options fall into three groups. **Guardrails** are the behavioral
thresholds: when the plugin announces cost, how often it audits, what counts as
a task boundary, and how hard a budget bites (`TOKEN_NORM_MODE`). **Budgets**
are opt-in and measured: set one and the plugin staples a status block onto
tool output the first time each metric crosses it. **Operational** options are
paths, path-adjacent tunings, and kill switches you will probably never touch.

**The variable names are host-neutral; their reach is not.** Every setting below
is read the same way on every host, but a host that cannot measure a thing cannot
enforce a budget on it, and the difference is stated rather than silently applied:

| Setting | OpenCode | Claude Code |
|---|---|---|
| `TOKEN_NORM_MAX_COST` | enforced | **inert** — a transcript carries no prices |
| `TOKEN_NORM_CONTEXT_LIMIT` | optional override | **required to enable the context axis** — no transcript field gives a window size |
| `TOKEN_NORM_MAX_EFFECTIVE_TOKENS` | enforced | enforced |
| `TOKEN_NORM_MAX_TOOL_CALLS` | enforced | enforced |
| Thresholds, `TOKEN_NORM_MODE` | enforced | enforced |

`doctor` reports an inert axis as a warning rather than a zero, because a zero on
screen is indistinguishable from a budget that is comfortably met. Codex is not
installable yet, so it has no column — see
[host support](../README.md#host-support).

### Guardrails (behavioral thresholds)

| Variable | Default | Meaning |
|---|---|---|
| `TOKEN_NORM_ANNOUNCE_AT` | `25` | Calls before the cost-statement reminder |
| `TOKEN_NORM_AUDIT_EVERY` | `60` | Calls between audit checkpoints |
| `TOKEN_NORM_BOUNDARY_AT` | `40` | Session size above which a new user message is a task boundary |
| `TOKEN_NORM_MODE` | `handoff` | `observe` logs only; `warn` injects; `handoff` adds a skeleton at a pause; `block` refuses non-cheap tools |

### Budgets (opt-in, measured)

| Variable | Default | Meaning |
|---|---|---|
| `TOKEN_NORM_MAX_COST` | unset | USD budget from provider cost. Inert on Claude Code, which cannot price a transcript |
| `TOKEN_NORM_MAX_EFFECTIVE_TOKENS` | unset | Fresh-token budget (input + 0.1×cache read + 1.25×cache write) |
| `TOKEN_NORM_MAX_TOOL_CALLS` | unset | Weighted tool calls; cheap tools excluded |
| `TOKEN_NORM_TOOL_WEIGHTS` | unset | `name=weight` list overriding the weight of individual tools |
| `TOKEN_NORM_PHASE_WEIGHTS` | unset | `name=weight` list by assistant mode (`plan`, `build`, ...) |
| `TOKEN_NORM_CONTEXT_WARN` | `0.8` | Fraction of the context window that counts as pressure |
| `TOKEN_NORM_CONTEXT_LIMIT` | model limit | Override the window size in tokens (bypasses the cached model lookup). On Claude Code this is the *only* way to enable the context axis |

Only `TOKEN_NORM_MAX_TOOL_CALLS` is weighted: raw call counts still drive the
announce, audit, and task-boundary thresholds and the policy's call-count axis,
so weights can never delay or advance a reminder. A budgeted call contributes
`TOOL_WEIGHTS.get(tool) ?? 1` times `PHASE_WEIGHTS.get(latest assistant mode) ?? 1`,
and cheap tools contribute nothing. For example, to make `bash` twice as
expensive while halving what planning-mode calls cost:

```sh
TOKEN_NORM_MAX_TOOL_CALLS=200 TOKEN_NORM_TOOL_WEIGHTS=bash=2,read=0.5 TOKEN_NORM_PHASE_WEIGHTS=plan=0.5
```

Unlisted tools and modes weigh `1`, so the variables only need the exceptions.

### Operational (paths, paths-adjacent, switches)

| Variable | Default | Meaning |
|---|---|---|
| `TOKEN_NORM_CHEAP_TOOLS` | `todowrite,question,skill` | Tools that do not count toward the budget |
| `TOKEN_NORM_HANDOFF_DIR` | `~/.local/share/opencode/handoff` | Where handoff notes are written |
| `TOKEN_NORM_LOG` | `~/.local/share/opencode/token-norm.log` | Threshold event log |
| `TOKEN_NORM_PYTHON` | `python3` | Interpreter for the audit script |
| `TOKEN_NORM_AUDIT_SCRIPT` | bundled | Override the audit script path |
| `TOKEN_NORM_SETTLE_MS` | `350` | Minimum wait after `session_new` before pre-filling (floor) |
| `TOKEN_NORM_SWITCH_WAIT_MS` | `2000` | Max wait for the new session before appending the prompt |
| `TOKEN_NORM_BUDGET` | `1` | Set `0` to disable the budget half |
| `TOKEN_NORM_HANDOFF` | `1` | Set `0` to disable the handoff tool |

The model window is read from the provider config once per provider/model and
cached for the life of the opencode process. Restart after changing provider
settings, or set `TOKEN_NORM_CONTEXT_LIMIT`, which bypasses the cache.

Every `~/.local/share` above follows `XDG_DATA_HOME` when it is set.

**The `opencode` in those two default paths is a wart, and it is deliberate.** The
paths are host-independent — the Claude Code host writes its handoff notes to the
same directory and reads the same log — and the name is left in place rather than
moved, because moving it would orphan every note already on disk. Override with
`TOKEN_NORM_HANDOFF_DIR` and `TOKEN_NORM_LOG` if you want them elsewhere.

The cheap set defaults to `todowrite`, `question`, and `skill`: planning and
asking should never burn the budget, since both usually *save* calls. Reads and
greps do count, because context is the thing you are paying for. To exempt them
anyway:

```sh
TOKEN_NORM_CHEAP_TOOLS=todowrite,question,skill,read,grep,glob
```

The variable replaces the default set rather than extending it, so list every
tool you want exempt.

## When a setting is wrong

A malformed value falls back to the default rather than failing the session, so
a typo used to leave you believing a budget was in force when none was. Every
rejected value is now reported once at load, to the log and as a toast:

```
config: TOKEN_NORM_MODE="blocking" ignored -- expected one of observe, warn, handoff, block; using handoff
```

Reported cases: a non-numeric or non-positive threshold or budget, a
`TOKEN_NORM_CONTEXT_WARN` outside `0`-`1`, a kill switch set to anything but
`0` or `1` (`false` and `off` do *not* disable a half), an empty
`TOKEN_NORM_CHEAP_TOOLS`, a malformed `name=weight` entry (that entry alone is
dropped and weighs `1`), and any unrecognized `TOKEN_NORM_*` variable, which is
almost always a misspelling of a real one.
