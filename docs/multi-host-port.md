# Porting token-norm to Claude Code and Codex

Status: **build order steps 1-6 implemented** (see 8); steps 7-8 remain.
Findings below were verified against local installs (Claude Code transcripts +
settings.json; codex-cli 0.146.0 config.toml + hooks.json), not inferred from
docs -- and the hook output schema against the installed Claude Code binary
itself (8d).

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
    5. src/usage/claude.ts  DONE  transcript JSONL reader, degrades to counting
    6. src/hosts/claude/    DONE  PreToolUse deny + PostToolUse inject
    7. installer --host claude   DONE  merges into ~/.claude/settings.json hooks
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

### 8c. What step 5 found in the real transcript (read before step 6)

The field names in §3 are right, but two things about the file's *shape* were
not in the research and both silently inflate every number:

- **One assistant response is written as one line PER CONTENT BLOCK**
  (`apiBlockIndex` 0,1,2...), and every one of those lines repeats the whole
  message's `usage` object verbatim. Measured here: 21 assistant lines, 6
  distinct `message.id`s, naive sum 27,070 output tokens against a true 7,215 --
  a **3.75x overcount**. `readTranscript` dedups by `message.id`, falling back to
  `requestId` then `uuid`. test/usage-claude.test.ts pins this.
- **`usage.iterations[]` and `usage.cache_creation{}` are breakdowns, not
  addends.** `iterations` itemizes retries of the same message; `cache_creation`
  splits `cache_creation_input_tokens` by TTL (5m/1h). Summing either into the
  totals double-counts. The reader takes the top-level numbers only.

Also worth knowing for the adapter:

- `usage` sits at `message.usage` on `type: "assistant"` lines. Session id is
  `sessionId` (camelCase) on those lines; other line types use `session_id`.
  The reader reads both.
- The reader returns cumulative `tokens` AND `latest` (the last measured turn).
  They are not interchangeable: `cache_read_input_tokens` is the whole window
  re-read every turn, so the cumulative sum is session spend and `latest` is
  window occupancy. Feeding the wrong one to the context axis makes a session
  look full after three turns.
- `turns.length` is the call-counting fallback and is populated even when
  `source` is `"counted"` -- i.e. the schema changed and no number was readable.
  `readTranscript` never throws; it returns `source: missing | unreadable |
  counted | measured` and the caller decides how much to trust it.
- Subagent turns are flagged (`sidechain`) but NOT filtered. Attribution is the
  adapter's policy call, not the reader's.

### 8d. What step 6 landed (Claude Code adapter)

The injection field from 8b, verified against the INSTALLED host (Claude Code
2.1.274) by reading its own bundled hooks reference out of the binary rather
than by trusting the research:

    systemMessage                      "Display a message to the user (all hooks)"
    hookSpecificOutput
      .hookEventName                   required, or the object is rejected
      .additionalContext               "Text injected into model context"
      .permissionDecision              "allow" | "deny" | "ask"  (PreToolUse only)
      .permissionDecisionReason        (PreToolUse only)

So `additionalContext` carries every reminder and `systemMessage` carries only
the severity line that replaces opencode's toast. The research answer
(`systemMessage`) would have delivered the whole norm to the human and nothing
to the model, and the hook would have looked healthy throughout. The top-level
`decision: "block"` is documented there as deprecated for PreToolUse; the
adapter uses `permissionDecision`. stdin keys: `hook_event_name`, `session_id`,
`transcript_path`, `cwd`, `tool_name`, `tool_input`, `tool_response`.

- **`budget/plugin.ts` now calls `state.save()` at each handler's exit**, which
  8a flagged as the single most likely way to wire an adapter up and count
  nothing. In the policy pass it is in a `finally`, because the surrounding
  `catch` swallows and the mutations have already happened. `track` already
  saved the increment, so `calls` cannot detect a missing save --
  test/plugin-persistence.test.ts asserts on `announced`, `pendingBoundary` and
  `level` instead, and 3 of its 4 cases fail if the save is removed.
- Event map: PreToolUse <- tool.execute.before, PostToolUse <-
  tool.execute.after, UserPromptSubmit <- message.updated (user), Stop <-
  session.idle/todo.updated, SessionEnd <- session.deleted. PostToolUseFailure
  counts the call and injects nothing -- a reminder stapled to an error reads
  as part of the error.
- UserPromptSubmit needs no message-id dedupe. It fires once per submission,
  unlike `message.updated`, which is what made the boundary reminder fire 61
  times in one session.
- Stop arms `pendingHandoff` and injects NOTHING, even though the host allows
  additionalContext there. Injecting on Stop continues the conversation, so a
  handoff recommendation delivered there restarts the session it is asking to
  end. It surfaces on the next tool call, as on opencode.
- SessionEnd deletes the record. Disk state is one file per session, so without
  it the state dir grows forever -- a leak opencode's in-memory Map never had.
- Exit code discipline: always 0, empty stdout when there is nothing to say.
  The host reads a non-zero exit as hook failure and exit 2 as "block", so a
  crash in the counting path would refuse the user's tool call.

Consuming the reader (the 8c warning, as implemented):

- Cumulative `tokens` -> the effective-token/spend axis. `latest` -> the context
  axis. Crossing them either way is a silent, permanent misreport.
- Occupancy comes from the last measured NON-sidechain turn, not `read.latest`.
  A subagent turn is real spend, so it stays in the cumulative total, but it
  runs in its own window and its occupancy is not this session's.
- **The cost axis is dropped on this host**, not reported as zero: the
  transcript records tokens and no prices. A metric reading "$0.00 / $5.00 (0%)"
  looks measured. TOKEN_NORM_MAX_COST is therefore inert here.
- **The context axis needs TOKEN_NORM_CONTEXT_LIMIT.** Nothing in the
  transcript gives a window size and there is no provider client to ask, so
  without it the axis is disabled -- the same "never guessed" rule
  evaluator.ts already applies to opencode.
- The audit checkpoint reports from the transcript, in usage-audit.py's own
  vocabulary (totals / effective fresh tokens / cache multiplier). usage-audit.py
  reads opencode's sqlite db and can only report that it found nothing for a
  Claude session; pointing the agent at another host's database at a checkpoint
  is worse than silence.

`node dist/hosts/claude/main.js` is a working hook command now (main.ts
self-invokes when run as a script). The unified `token-norm hook <host> <event>`
binary from 5 should import `main` rather than duplicate it.

### 8b. Before writing the Claude adapter (step 6)

Verify the PostToolUse context-injection field against the installed Claude Code
version first. The research returned `systemMessage`, but that field is
user-visible; `additionalContext` is the model-visible one. Getting it wrong
means the reminder renders to the human and never reaches the model -- which is
precisely the failure this project exists to prevent, and it would look like
success from the outside.

### 8e. What step 7 landed (installer --host claude)

`--host opencode|claude` on install / doctor / uninstall, `--dry-run` for both
write paths. The flag's value is consumed during parsing because the subcommand
is "the first bare argument": left in place, `--host claude` would have been
read as a command named `claude`.

**Why a copied bundle rather than the package's own dist.** A hook command is an
absolute path inside a config file, and `npx` unpacks this package into a cache
directory that is then deleted -- registering `node <pkgRoot>/dist/...` would
leave settings.json pointing at nothing a day later. So `dist/claude-hook.mjs`
(esbuild, self-contained) is copied to `~/.claude/token-norm/hook.mjs`, the same
reasoning that makes the OpenCode side copy `dist/plugin.js`. The extension is
`.mjs` on purpose: nothing puts a package.json next to the installed file, so
node would read a `.js` ESM bundle as CommonJS and the hook would fail at load.

**The merge rules.** settings.json is a file the user owns and third parties
already write to (rtk and orca, across ten events, on the machine this was
developed against). So:

- Additive only. Our entries are identified by the installed hook path, not by
  the word "token-norm", so an unrelated user hook that mentions the project is
  never removed by our uninstall.
- An install that finds our entry already there rewrites it in place -- a moved
  install path or a changed timeout is corrected, not duplicated. Install is
  idempotent by assertion, not by hope.
- Uninstall prunes an emptied matcher group and an emptied event array, because
  those are our litter; an event that still holds a third-party hook keeps it.
- A settings.json that does not parse is **refused, not replaced** (exit 1, file
  untouched). A JSONC file with comments therefore fails safely rather than
  being rewritten as strict JSON with the comments dropped.
- Writes go to a sibling and are renamed, so a half-written file cannot take the
  host's entire configuration with it.
- Matcher convention copied from what this host's own settings.json uses: `"*"`
  for the three tool events, no matcher for UserPromptSubmit / Stop / SessionEnd.

`CLAUDE_CONFIG_DIR` is honoured when set. Claude Code 2.1.274 is not documented
to read it and the binary is packed -- grepping it for the answer returns zero
hits even for `UserPromptSubmit`, a name that certainly exists, so that grep is
not evidence either way. Respecting an explicitly-set value is the choice that
is wrong in no case.

`doctor --host claude` checks the package bundle, the installed bytes (sha256
against this package), the registration, the shared TOKEN_NORM_* diagnostics,
and the two degraded axes. Installed-but-unregistered is its own `fail`: the
hook file can be byte-perfect and the host will still never run it. The axes
from 8d are reported as warnings at both install and doctor time, because a
missing axis is invisible at runtime -- it looks exactly like an axis that is
fine.

`tools/provenance.mjs` now hashes three artifacts, not two: the Claude hook is a
loose executable file on a user's machine with no registry tarball behind it,
which is the same argument that put the other two in there.

Verified: `npm test` 236 passed (was 217), and a real-process run of the
*installed* bundle -- three separate `node ~/.claude/token-norm/hook.mjs`
invocations counted 1 -> 2 -> 3 through the disk store, the announcement arrived
on call 3 in `additionalContext`, and `not json` on stdin exited 0 with empty
stdout.

**Not done here, on purpose:** the README still documents only the OpenCode
install. Writing the Claude section means also stating the 6 handoff degradation
plainly (no host can start a session, so handoff becomes "write the note, then
run /clear"), and that belongs with the SessionStart injection that recovers it
-- not stapled to an installer change. Step 8 (live smoke test in a real
session) is the next step.

### 8f. What the live run showed (step 8)

Claude Code 2.1.274 on this host, against the installed bundle at
`~/.claude/token-norm/hook.mjs` and the real `~/.claude/settings.json`.
`npm test` re-run from a removed `dist/` first: 236 passed, 17 files.

**No restart was needed, and that is not what the installer says.** The merge
was picked up by every session that was *already running* -- three of them,
within 34 seconds, with no restart and no new session. So this host consults the
hook config per invocation rather than caching it at startup. The install
output's "Restart Claude Code to load it" was written from the temp-dir smoke
test and is conservative rather than wrong; it is left in place because it is
correct for a version that does cache, and being told to restart unnecessarily
costs nothing while the reverse costs a silent no-op.

One consequence worth knowing: a session that was already running when the hook
lands is counted from zero at that moment, so its `calls` understates what that
session has really spent. Only sessions that start after the install are
accurate.

**Counting across hook processes, in a real session.** Every tool call is a
separate `node hook.mjs` process, and the count survives between them through
the disk store: this session's record went 4 -> 6 -> 7 on consecutive reads,
one increment per tool call, `tools` accumulating `["Bash", n]`.

**Concurrent sessions do not collide.** The three live sessions were in three
different project directories and produced three state files keyed by the host's
`session_id`, each with its own histogram (`Read` x5, `Bash` x5, `Bash` x4).
Attribution was checked against `~/.claude/projects/<slug>/<session-id>.jsonl`
rather than assumed -- with three files appearing at once, guessing which one is
"mine" is how a cross-talk bug gets recorded as working.

**The announcement, at the real default threshold.** Driven on a throwaway
session id through the installed bundle, the first non-empty stdout arrives on
call **25** exactly, and it is shaped as 8d requires:

    hookSpecificOutput.hookEventName   "PostToolUse"
    hookSpecificOutput.additionalContext   the full <system-reminder> ... reminder
    systemMessage                      "Token norm: ATTENTION (25 calls)"

No `permissionDecision` on a PostToolUse payload, no deprecated top-level
`decision`, and `JSON.parse` accepts the bytes. The severity line goes to the
human, the norm goes to the model -- the inversion 8b warns about is not there.

**Stop and SessionEnd.** Stop: exit 0, stdout empty -- it injects nothing, so it
cannot continue the conversation it is trying to end. SessionEnd: exit 0, stdout
empty, and the session's state file is gone afterwards, so the state dir does
not grow forever.

**Differs from the temp-dir smoke test: the record is created by PostToolUse,
not PreToolUse.** A PreToolUse on an unknown session writes no file at all; the
file appears on the first PostToolUse, because `track` is what stages an
increment. So 8a/8d's "save at each handler's exit" does not mean "every handler
creates the record". The first policy pass of a session therefore reads
`calls: 0`, which is correct -- nothing has run yet -- but it means an empty
state dir after a few PreToolUse events is not evidence of a missing save.

**Install against the live file.** 0 pre-existing hook entries lost, 6 added, 17
total, sitting beside rtk and orca; every non-hook top-level setting
byte-identical to the pre-install snapshot (compared structurally, since a
re-serialized diff is almost all reindentation noise). A second `install` printed
"already registered ... refreshed the command" and left the count at 6, so
idempotence holds on a real file and not just a fixture. `doctor --host claude`:
ready, with the two expected warnings (cost axis inert, context axis needs
`TOKEN_NORM_CONTEXT_LIMIT`). `uninstall --host claude --dry-run` lists all six
events plus the hook file.

**A trap in verifying this, not in the code.** Shell `echo "$out"` expands the
`\n` escapes inside the JSON string into raw newlines, and the result fails to
parse with `Invalid control character at ... char 91` -- char 91 being exactly
where the first escape sits in the announcement. That looked like the hook
emitting malformed JSON and the host silently dropping every reminder, i.e. the
worst possible outcome, and it was the test harness. Check hook stdout by
redirecting to a file and parsing that (`JSON.parse`, `python3 -m json.tool <
file`); never pipe it through `echo`.

**Left for normal use, not verifiable from inside one session:**

- The announcement landing in a *real* session's context. The check above
  exercises the same installed bytes at the same threshold, but a session cannot
  cheaply drive itself to 25 calls without 17 filler calls, which is precisely
  the spend the norm exists to prevent. The first real session that crosses 25
  settles it; if the text appears as a reminder in context rather than only as a
  one-line notice to the human, `additionalContext` is confirmed end to end.
- SessionEnd on a real session (the test used a throwaway id): after closing a
  session, its `<uuid>.json` should disappear from
  `~/.local/state/token-norm/claude/`.
- Stop on a real session: the observable is that the turn simply ends.
