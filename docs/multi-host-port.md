# Porting token-norm to Claude Code and Codex

Status: **design only. Nothing implemented.** Findings below were verified
against local installs (Claude Code transcripts + settings.json; codex-cli
0.146.0 config.toml + hooks.json), not inferred from docs.

## 1. Why this is an architecture change, not a port

The enforcement half binds to opencode's *in-process plugin* model: long-lived
module state, `tool.execute.before/after`, a live `client` for toasts and the
provider window. Claude Code and Codex expose *process-level hooks*: a fresh
process per event, JSON on stdin, JSON on stdout. Same policy, different
plumbing.

The audit half binds to opencode's sqlite DB. Both new hosts persist JSONL
instead.

## 2. What already ports unchanged

12 of 16 source files import no host SDK and take numbers in / return text out:

    config, usage, log, audit, status(core), and budget/{policy, evaluator,
    reminders, state, format}

Only 4 are host-bound: `index.ts`, `budget/plugin.ts`, `handoff.ts`, and the
`tool()` wrapper in `status.ts`.

## 3. Verified host capability matrix

| capability            | opencode                              | Claude Code                          | Codex 0.146                          |
|-----------------------|---------------------------------------|--------------------------------------|--------------------------------------|
| block a tool call     | throw in `tool.execute.before`        | `PreToolUse` -> `permissionDecision: "deny"` | `PreToolUse` -> `permissionDecision: "deny"` |
| inject context        | mutate `output.output`                | `PostToolUse` hookSpecificOutput     | `PostToolUse` `additionalContext`    |
| compaction context    | `experimental.session.compacting`     | `PreCompact`                         | `PreCompact` / `PostCompact`         |
| session lifecycle     | `session.*` events                    | `SessionStart` / `SessionEnd`        | `SessionStart` / `SessionEnd`        |
| pause signal          | `session.idle`, `todo.updated`        | `Stop`                               | `Stop` / `Interrupt`                 |
| subagent detection    | agent mode on event                   | matcher on Task                      | `SubagentStart` / `SubagentStop`     |
| measured tokens       | `step-finish` parts                   | transcript JSONL `usage`             | rollout JSONL `token_count`          |
| user-visible notice   | `client.tui.showToast`                | `systemMessage`                      | `systemMessage`                      |
| programmatic new session | `tui.executeCommand("session_new")` | **none**                             | **none**                             |

### Config shapes (verified on disk)

Both hosts use the *same* hook object structure -- this is the big win:

    { "hooks": { "<Event>": [ { "matcher": "...", "hooks": [ {"type":"command","command":"...","timeout":10} ] } ] } }

- Claude Code: under the top-level `hooks` key of `~/.claude/settings.json`.
- Codex: `~/.codex/hooks.json` (or inline `[hooks]` in config.toml). Event keys
  are **PascalCase** in the file. The snake_case seen under `[hooks.state]` in
  config.toml is only the trust-hash key encoding -- not the schema.
- Codex trusts hooks by `sha256` recorded in `[hooks.state]`; changing an
  installed hook command re-prompts for trust. The installer must expect this.

### Token fields (read from real files here)

- Claude Code `~/.claude/projects/<slug-of-cwd>/<session-id>.jsonl`:
  `usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
  output_tokens, output_tokens_details.thinking_tokens}`.
  Maps 1:1 onto the existing `RawTokens` shape in `host.ts`.
  CAVEAT: Anthropic documents this file as internal and version-unstable. The
  reader must be defensive and degrade to call-counting, never throw.
- Codex `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`: `TokenUsage
  { input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
  reasoning_output_tokens, total_tokens }` plus `model_context_window` --
  which gives the context axis for free, no provider lookup needed.
  Gated by `history.persistence`; if set to `none` there is nothing to read.

## 4. The central piece of new work

`budget/state.ts` holds counters in a module-level `Map`. A hook process dies
after every tool call, so that Map must become a disk-backed store:

- keyed by session id, under `$XDG_STATE_HOME/token-norm/<host>/<id>.json`
- atomic write (tmp + rename); concurrent hooks are possible
- Sets/Maps need explicit serialization (`crossed`, `seenMessages`, `tools`)
- the monotone `level` invariant must survive a reload -- see the comment in
  state.ts; test/budget-state.invariants.test.ts already pins this behaviour
- opencode keeps an in-memory backend so its fast path is unchanged

## 5. Proposed shape

    src/core/        <- existing host-neutral modules (mostly a no-op move)
    src/runtime/store.ts     <- memory | disk state backends
    src/usage/claude.ts      <- transcript JSONL reader
    src/usage/codex.ts       <- rollout JSONL reader
    src/hosts/opencode/      <- today's plugin.ts + handoff.ts + index.ts
    src/hosts/claude/        <- stdin/stdout hook adapter
    src/hosts/codex/         <- stdin/stdout hook adapter
    src/cli/hook.ts          <- one binary: `token-norm hook <host> <event>`

Installer: extend `scripts/install-local.mjs` with `--host claude|codex|opencode`,
keeping install / doctor / uninstall / --dry-run. It MUST merge into existing
hook config, never overwrite: this machine already has third-party hooks (rtk,
orca) registered in both files.

Audit: `scripts/usage-audit.py --host` with JSONL readers beside the sqlite one.

## 6. Known degradation: handoff

Neither new host can start a session programmatically. Handoff degrades to:
write the note (unchanged), then surface the path plus an instruction to run
`/clear` (Claude Code) or start a fresh `codex`. `SessionStart` can then inject
the pending note into the new session, which recovers most of the value.
This must be stated plainly in the README rather than papered over.

## 7. Decisions taken

1. **Rename to `token-norm`.** npm `opencode-token-norm` -> `token-norm`; repo
   `salitaba/token-norm`; bin `token-norm hook <host>`. The old package gets a
   final release whose README points at the new name. Done now, at 0.11.0,
   before the install base grows.
2. **Claude Code adapter first**, then Codex. Rationale: it is the host running
   here, so it can be smoke-tested live, and its transcript format is the
   officially-unstable one -- writing the defensive reader first means the
   Codex reader is the easy case, not the other way round.

## 8. Build order

    1. src/runtime/store.ts      DONE  disk-backed session state, atomic writes
    2. serialization             DONE  Sets/Maps (crossed, seenMessages, tools)
    3. invariant                 DONE  monotone `level` survives a reload
    4. src/core/ move            DONE  host-neutral modules, suite green
    5. src/usage/claude.ts       transcript JSONL reader, degrades to counting
    6. src/hosts/claude/         PreToolUse deny + PostToolUse inject
    7. installer --host claude   MERGE into ~/.claude/settings.json hooks
    8. live smoke test

Steps 1-4 changed no behaviour: 174 tests green before and after, and OpenCode
still runs on the in-memory backend it always used. Do not start step 5 in the
same session as the rename -- the rename touches package.json, README, installer
and CI, and mixing it with a state refactor makes a bisect useless.

### 8a. What steps 1-4 actually landed, where it differs from §5

- `src/runtime/store.ts` holds `SessionStore` with two backends. `MemoryStore`
  is the old Map; `DiskStore` is one JSON file per session under
  `stateDir(host)` (`src/core/config.ts`), written tmp + rename.
- **`set` stages, `save` writes.** `set` never touches disk. A plain overwrite
  racing another hook's `save` is how an increment gets erased, so `save` is the
  only writer and it folds against what is on disk first.
- **The merge rule is per-field, and it is the whole of step 3.** Counters and
  `level` take max, `crossed`/`seenMessages` union, `announced` ors, the
  consumable pause flags and `axisLevels` take the writer's value. The reasoning
  for each is in the `merge` comment in `core/budget/state.ts` -- read it before
  adding a field, because the wrong rule here un-escalates a session silently.
- `state` is now `export let` behind `setStateStore()`, so a host adapter swaps
  the backend at startup and existing importers follow the live binding. No call
  site in `budget/plugin.ts` changed.
- **`budget/plugin.ts` does not call `state.save()` yet.** Harmless today --
  MemoryStore holds the same object the plugin mutates, so `save` is a no-op --
  but a disk backend persists nothing without it. Step 6 must add a `save` at
  each handler's exit. This is the single most likely way to wire the Claude
  adapter up and have it silently count nothing.
- `status.ts` was split, not moved: `src/core/status.ts` is the accounting,
  `src/status.ts` is the OpenCode `tool()` wrapper that re-exports it.
- `budget/plugin.ts` stayed at `src/budget/`. §5 puts it under
  `src/hosts/opencode/`; that move belongs with step 6, when there is a second
  host directory to justify the shape.
- `AUDIT_SCRIPT` now finds `scripts/usage-audit.py` by walking up rather than by
  a fixed `../`. tsc emits config to `dist/core/`, esbuild inlines it into
  `dist/plugin.js`, and vitest loads `src/core/` -- no one depth suits all three.
- `scripts/install-local.mjs` doctor accepts `dist/core/config.js` and the old
  `dist/config.js`, so it still reports settings against an older install.

Two traps found the hard way, both worth keeping:

- A stale `dist/` masked the installer break above; only `rm -rf dist && npm
  test` surfaced it. Do that before believing a layout change is green.
- `fs.mkdirSync` on a path under `/proc` does not return on this kernel -- it
  hangs rather than throwing EACCES. Do not use `/proc` as an "unwritable
  directory" fixture; a path under a regular file gives ENOTDIR immediately.
  It also means the disk store can in principle block a hook process on a
  pathological state dir. XDG_STATE_HOME makes that unlikely, not impossible.

### 8b. Before writing the Claude adapter (step 6)

Verify the PostToolUse context-injection field against the installed Claude Code
version first. The research returned `systemMessage`, but that field is
user-visible; `additionalContext` is the model-visible one. Getting it wrong
means the reminder renders to the human and never reaches the model -- which is
precisely the failure this project exists to prevent, and it would look like
success from the outside.
