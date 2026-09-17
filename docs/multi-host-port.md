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
    8. live smoke test           DONE  installed here, see 8f
    9. SessionStart injection    DONE  recovers the handoff step, see 8g
   10-16. Codex host             NEXT  reader, adapter, installer, audit -- see 9

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

- ~~The announcement landing in a *real* session's context.~~ **Settled during
  step 9**: the session doing that work crossed 25 of its own tool calls and the
  reminder arrived in its context, through the installed hook, as
  `additionalContext` -- not as a notice to the human. The delivery field is now
  confirmed end to end on a real session and not only by direct invocation.
- SessionEnd on a real session (the test used a throwaway id): after closing a
  session, its `<uuid>.json` should disappear from
  `~/.local/state/token-norm/claude/`.
- Stop on a real session: the observable is that the turn simply ends.

### 8g. SessionStart injection, and the handoff that had no tool (step 9)

Step 8 left the README unwritten because documenting the Claude install means
documenting the handoff degradation, and 8e argued that belongs with the fix
rather than stapled to an installer change. Writing it turned up that the
degradation was worse than "one step becomes two".

**The shipped adapter told the model to call a tool that does not exist.**
`reminders.ts` closes the handoff skeleton with `3. Call the handoff tool once
the user agrees`, and the handoff tool is opencode-only -- `adapter.ts` says so
in a comment three screens away. So on this host a session that reached
HANDOFF_RECOMMENDED was instructed, at the exact moment it was already over
budget, to spend a turn on a call that could only fail. `handoffLines` now takes
an optional `closing`, the opencode default is unchanged, and the Claude adapter
passes the two steps a user can actually perform. A test asserts the default
still says "call the handoff tool" and that a replaced closing does not.

**The host's SessionStart contract, read out of the binary rather than guessed.**
Claude Code 2.1.274's own zod schemas give both directions:

    output  hookEventName: "SessionStart", additionalContext?, initialUserMessage?,
            sessionTitle?, watchPaths?, reloadSkills?
    input   source: ["startup","resume","clear","compact","fork"], agent_type?,
            model?, session_title?, seconds_since_last_response?, context_tokens?

`additionalContext` carries the note. `initialUserMessage` is deliberately NOT
used: it would fabricate a user turn, and the handoff is the previous session
talking, not the user.

**`source` is the whole design.** Only `startup` and `clear` begin with an empty
window. `resume` and `fork` continue a transcript and `compact` replaces one
with a summary of itself -- injecting there duplicates context the model already
has, and on `compact` it re-injects precisely what compaction ran to discard. An
unrecognised source is treated as resuming, so a future source fails closed.

**Two rules the note itself needs, for the same reason SessionEnd deletes state:**

- **Consume once.** A note is renamed to `handoff.injected.md` as it is
  delivered, and marked *before* it is returned: if the rename fails the note is
  not injected at all. The choice is between a note that arrives once-or-never
  and one that arrives at the start of every future session in that project; the
  first is recoverable by hand, the second is not. Renamed rather than deleted,
  because the note is the agent's own writing and the fixed filename means a
  later consume overwrites the previous one instead of growing a pile.
- **Scope by directory, not by content.** The note lives at
  `HANDOFF_DIR/notes/<slug(cwd)>/handoff.md`, so a note can only reach a session
  whose cwd produces the same slug. A fixed filename is also what makes the path
  nameable in a reminder -- the agent has to be able to write it without
  inventing a timestamp, and the reader has to find it without globbing and
  choosing between candidates.

**What this gives up.** opencode's own notes are written flat in `HANDOFF_DIR`
with a prose trailer (`_from session X in DIR_`) and no project subdirectory, so
they are never injected into a Claude session. Cross-host pickup was considered
and dropped: the alternative was regex-parsing that trailer for a directory, and
a wrong parse means a note from one repo injected into another. `HANDOFF_DIR`
still has `opencode` in its path while the core is host-neutral; that wart is
left alone rather than moved, because moving it would orphan every note already
on disk.

Verified live, through the installed bundle at `~/.claude/token-norm/hook.mjs`:
`source=clear` injected the note in `additionalContext`; `resume` and `compact`
injected nothing and left the note in place; and a following `startup` injected
nothing **because the `clear` had already consumed it** -- consume-once
demonstrating itself rather than an exclusion. `npm test` 249 passed (was 236)
from a removed `dist/`, and the installer now registers seven events, the new
one landing in place beside the six already there.

**Still not verified, and it needs one human action:** a real `/clear` in a real
session. The above drives the installed hook as a process with a synthetic
`source`; only the host itself can prove it sends `source: "clear"` on a
`/clear` and renders what comes back. A note written by this session is in place
for exactly that test.

## 9. Codex build order (steps 10-16)

Written after step 9 landed and before any Codex code exists. What follows is
the order, plus the findings from the Claude port that change it. The open
questions in §9d must be answered from real files the way §8b and §8c were --
not from docs, and not by assuming Codex resembles Claude Code because their
hook config happens to share a shape.

### 9a. Verified on this host (2026-09-17)

    codex-cli 0.146.0                       on PATH
    ~/.codex/hooks.json                     5270 bytes, ALREADY POPULATED
    ~/.codex/sessions/**/rollout-*.jsonl    414 files
    ~/.codex/config.toml                    [hooks.state], 11 trust entries

The hooks file is a top-level `hooks` object with **PascalCase** event keys,
and the group shape is the one the Claude installer already writes:

    { "hooks": { "SessionStart": [ { "hooks": [ {"type":"command","command":"...","timeout":10} ] } ] } }

Registered here today (orca's): SessionStart, UserPromptSubmit, PreToolUse,
PermissionRequest, PostToolUse (2 groups), SubagentStart, SubagentStop, Stop
(2 groups). A SessionStart group carried no `matcher` key at all, matching the
`[event, null]` rows the Claude installer uses for session events.

Two things follow that §3 does not say:

- **`PermissionRequest` exists** and is absent from the matrix. token-norm does
  not need it -- `PreToolUse` already carries the deny -- but the installer must
  tolerate event keys it does not know rather than treat them as corruption.
- **Several groups per event is normal**, so "append a group" is the correct
  merge, which is what `installClaude()` already does.

Trust entries are keyed by hook file path, snake_case event name, and two
indices:

    [hooks.state."/home/alitabatabaei/.codex/hooks.json:post_tool_use:0:0"]
    [hooks.state."/home/alitabatabaei/Desktop/code/lecture-test/.codex/hooks.json:post_tool_use:0:0"]

The second one is a **project-local** `.codex/hooks.json` in an unrelated repo,
so Codex reads per-project hook files as well as the global one. Three
consequences for step 13, and together they are why the Codex installer is not
a copy of the Claude one:

1. **The trust key contains indices.** Inserting a group anywhere but the end
    shifts the keys of every later group and re-prompts the user to trust hooks
    they already trusted. Append only; never sort, never reorder, never rewrite
    an existing group to normalize its formatting.
2. **Installing re-prompts for our own hook** -- the hash covers the command we
    write, so this is unavoidable (§3 says so). Say it before writing, so the
    prompt does not read as a failure.
3. **There are two install scopes.** Global `~/.codex/hooks.json` is the default;
    a project-local file exists as a concept. Pick global and say so.

### 9b. The order

    10. src/usage/codex.ts       DONE  rollout JSONL reader, same contract as claude.ts
    11. src/hosts/codex/         DONE  protocol + measure + adapter + main (+ index), see 9i
    12. SessionStart injection   reuse core/handoff-notes.ts, Codex closing text
    13. installer --host codex   hooks.json, additive, append-only, re-trust note
    14. usage-audit.py --host    JSONL reader beside the sqlite one
    15. src/cli/hook.ts          the unified `token-norm hook <host> <event>`
    16. live smoke test          the §8f/§8g equivalent, confirm-first

One step per session, except 14+15 which are small and adjacent. Step 15 is the
binary from §5, and it is only now justified: with two hook hosts the
duplication is real rather than anticipated. Per §8d it must import each host's
`main` rather than re-implement the stdin/stdout dance.

### 9c. What the Claude port already settled (do not re-derive)

Host-neutral, verified, and reusable as-is:

- `core/handoff-notes.ts` -- note on disk, scoped by `projectSlug(cwd)`, 24h
  TTL, consume-once by rename to `handoff.injected.md`. Nothing in it is
  Claude-specific, **provided** Codex's SessionStart carries a `cwd` (§9d).
- `handoffLines(sessionID, closing?)` already takes a host-specific closing.
  Codex's says "start a fresh `codex`", not "/clear". The opencode default
  still says "call the handoff tool" and must keep saying it.
- Cumulative tokens feed the **spend** axis; the latest turn alone feeds the
  **context** axis. Summing cache reads across turns reports a session that
  never grew as half full -- there is a test pinning exactly this.
- Subagent turns count as spend but not as this session's window.
- Reminders go to the model via `additionalContext`. `systemMessage` renders to
  the human only, so a reminder delivered there reaches nobody who can act.
- Exit 0 with empty stdout when there is nothing to say. Non-zero is a hook
  failure; 2 blocks.
- `PostToolUse` creates the state record, not `PreToolUse`. An empty state dir
  after a PreToolUse-only session is expected, not the missing-`save` bug.

### 9d. Answer from real files before writing step 10

Each of these cost a bug or a wrong assumption on the Claude side, so they are
worth a read-only session that records its findings in a §9g first:

1. **Does one assistant turn repeat its `TokenUsage` across several rollout
    lines?** The Claude transcript does -- one line per content block, each
    carrying the same `usage` -- and without dedup by `message.id` the reader
    overcounted by 3.75x, measured. Find Codex's dedup key, or prove it does not
    need one.
2. **Is `total_tokens` the sum of the other fields, or a breakdown?** Claude's
    `usage.iterations[]` and `cache_creation{}` looked like addends and are not.
3. **Which rollout file belongs to the live session?** The reader gets a session
    id from the hook; Claude hands over `transcript_path` outright, while the
    Codex path is date-partitioned (`sessions/YYYY/MM/DD/rollout-<ts>-<id>`).
    Globbing by id across 414 files is the fallback, not the plan.
4. **What does SessionStart actually send?** Specifically whether it carries a
    `cwd` (§9c depends on it) and what its `source` enum is. Claude's is
    `["startup","resume","clear","compact","fork"]`, read out of the binary
    rather than the docs; the adapter fails closed on an unknown value. Codex
    needs its own enum, not Claude's.
5. **Does `Interrupt` or `SubagentStop` need handling**, given Claude does
    subagent detection with a matcher and Codex has explicit events?

### 9e. Known degradation on Codex, stated up front

- **The cost axis stays omitted.** `TokenUsage` has no prices, exactly like the
  Claude transcript. Omitted, never reported as a zero -- a zero reads as "you
  have spent nothing".
- **The context axis works out of the box**, which is the one place Codex is
  better: `model_context_window` is in the rollout, so `TOKEN_NORM_CONTEXT_LIMIT`
  becomes an override rather than a requirement. Prefer the file's value.
- **`history.persistence = none` leaves nothing to read.** That is the Codex
  analogue of an unreadable transcript: degrade to call counting, report it in
  `doctor`, and never throw.
- **No programmatic new session** (§6), so the handoff is the same two manual
  steps as on Claude Code: write the note, start a fresh `codex`.

### 9g. What the rollout files actually contain (answers to 9d)

Read on 2026-09-17 from 4 of the 414 rollout files under
`~/.codex/sessions/`, 1237 `token_count` records in total. Structure only -- these
files hold real conversations, which is itself a finding (see below).

Every line is `{timestamp, type, payload}`. Record types seen in one 206-line
file: `response_item` (127), `event_msg` (72), `turn_context` (5),
`session_meta` (1), `world_state` (1). The token numbers live in `event_msg`
payloads of type `token_count`:

    {"type":"token_count","info":{"total_token_usage":{...},"last_token_usage":{...},
      "model_context_window":258400},"rate_limits":null}

**1. No dedup is needed, and no turn accumulation either.** This is the big
difference from Claude Code, and it makes `src/usage/codex.ts` the easy case
§7 predicted. `info.total_token_usage` is already cumulative and rises
monotonically (verified across all 1237 records), so the reader takes the
**last** `token_count` record and is done: `total_token_usage` is the spend axis,
`last_token_usage` is the context axis. There is no repeated-`usage`-per-content-block
trap here, so nothing plays the part `message.id` dedup plays on the Claude side.
One caveat: the **first** record can report a zero cumulative alongside a
non-zero `last_token_usage.total_tokens` (4542 in the file read here). Read the
last record, never the first.

**2. `total_tokens` is `input_tokens + output_tokens`.** Verified
1237/1237. The other two plausible readings are false in every single
record: `input+output+reasoning` (0/1237) and
`(input-cached)+output+reasoning` (0/1237). What is
actually going on is that **both extra fields are breakdowns, not addends**:
`cached_input_tokens <= input_tokens` in 1237/1237 records and
`reasoning_output_tokens <= output_tokens` in 1237/1237. Summing all
four fields, which is the obvious thing to write, overcounts by 1.96x on
the largest file read here (14,080,016 reported vs 27,572,797 summed). This is §8c's
`cache_creation{}`/`iterations[]` trap in a new costume; treat `total_tokens`
as authoritative and never reconstruct it.

**3. A session's file is found by id in the filename, not by date.** The name is
`rollout-<local-timestamp>-<session-id>.jsonl` and the id matches
`session_meta.id`, so a glob on the id is exact and needs no content scan.
Do **not** compute the `YYYY/MM/DD` partition from a timestamp: the directory
and the filename use **local** time while `session_meta.timestamp` is UTC. In
the file read here that is `sessions/2026/07/22/rollout-2026-07-22T14-00-13-...`
against `2026-07-22T10:30:13.810Z` -- a 3.5 hour gap, because this machine is
UTC+03:30, and any naive date arithmetic lands in the wrong directory for a
third of the day.

**4. `session_meta` (line 0) is richer than expected** and carries
`session_id`, `id`, `timestamp`, `cwd`, `originator`, `cli_version`, `source`,
`thread_source`, `model_provider`, `base_instructions`, `history_mode`,
`context_window`, `git`. Three of those matter: `cwd` scopes the handoff note
without the hook having to supply it, `history_mode` is where the
`history.persistence` gate shows up (§9e), and `context_window` corroborates
`model_context_window`. The context axis therefore needs no
`TOKEN_NORM_CONTEXT_LIMIT` on this host -- it is 258400 in the file read here,
stated in every `token_count` record.

**5. The format drifts across versions.** The file read here says
`cli_version: "0.144.6"`; the installed binary is 0.146.0. Same defensive
posture as the Claude reader: degrade to call counting, never throw.

**6. Rollouts contain the full conversation.** `task_complete` payloads carry
`last_agent_message` verbatim, and `response_item` records hold the turns. The
reader must never log a payload and the audit must never print one -- on the
Claude side the transcript reader only ever emitted token numbers, and that has
to stay true here.

Still open from §9d, and both need Codex's hook *input* schema rather than its
output files: **what `SessionStart` sends** (specifically whether it carries a
`cwd`, and its `source` enum -- Claude's is
`["startup","resume","clear","compact","fork"]`, read out of the binary) and
**whether `Interrupt`/`SubagentStop` need handling**. Answer those the way §8d
was answered -- out of the binary, not the docs -- before step 11.

### 9h. Codex's hook wire format, read out of the binary (answers to 9d 4-5)

Read on 2026-09-17 from the native binary behind the Node launcher:
`@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`,
296 MB, via `strings -n 5`. There is no `codex hooks` subcommand that dumps a
schema, though the binary does embed a draft-07 JSON Schema for the app-server
protocol (`SessionStartHookSpecificOutputWire`, `"const": "SessionStart"`), so
a cleaner source may exist under `codex app-server` if this ever needs
re-checking.

The evidence is serde's concatenated field-name blob, which lists the hook
input fields together:

    session_id  transcript_path  hook_event_name  reason  permission_mode
    turn_id  agent_transcript_path  agent_type  last_assistant_message

and, immediately before it, the event names and the `source` values:

    SessionEnd  startup resume clear compact  SubagentStart  SubagentStop

**4. The `source` enum is `startup | resume | clear | compact` -- four values,
and `fork` is not one of them.** Claude Code's is five
(`["startup","resume","clear","compact","fork"]`), so §9d was right that Codex
needs its own enum. The good news is that `resumesContext()` in
`hosts/claude/protocol.ts` transfers unchanged as a *predicate*: it injects on
`startup` and `clear` and skips everything else, which is the correct behaviour
for all four Codex values, and an unknown value still fails closed. Copy the
predicate, not the enum.

**`cwd` is NOT among the hook input fields, and that changes step 12.** Claude
Code sends one; Codex appears not to. So `core/handoff-notes.ts` cannot be
reused as-is -- `projectSlug(cwd)` has nothing to slug. The fix uses only
verified facts and needs no new plumbing: the input carries `transcript_path`,
and §9g established that line 0 of a rollout is a `session_meta` record with a
`cwd` field. So the Codex adapter resolves its own cwd by reading the first line
of the transcript it was handed, then calls the same host-neutral note reader.

Confidence, stated honestly: the field list above is positive evidence of what
the input *has*. The absence of `cwd` is inferred from that blob, and the one
grep that would have confirmed it independently died on a regex complexity limit
(see the tooling note below), so step 12 should confirm absence against a real
`SessionStart` payload before building on it. The `session_meta` fallback is
worth writing either way, since it also covers a `cwd` that is missing or stale.

**5. Subagents are structural here, and better than on Claude Code.**
`SubagentStart` and `SubagentStop` are real events, and the input carries
`agent_type` and `agent_transcript_path` -- so a subagent's spend can be
attributed from the payload instead of inferred from a matcher on Task, which
is how §8d had to do it. `Interrupt`, which §3's matrix lists beside `Stop`,
did **not** appear among the event names in the blob (`PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PreCompact`, `SessionEnd`,
`SubagentStart`, `SubagentStop` did). Treat that row of the matrix as
unconfirmed rather than as a requirement.

Four things fell out that were not asked for and that change later steps:

- **The output wire is camelCase, like Claude's.** `HookUniversalOutputWire`
  carries `systemMessage`, `additionalContext`, `stopReason`, `suppressOutput`
  and `reason`. `permission_decision` appears zero times in the binary, so the
  deny path is camelCase too. The §9c rule holds verbatim: the reminder goes in
  `additionalContext`, never `systemMessage`.
- **`HookHandlerConfig` accepts more than `{type, command, timeout}`**:
  `commandWindows`, `async`, `statusMessage`, `additionalContextLimit`,
  `description`, `matcher`, plus `prompt` and `agent` handler kinds. Two matter.
  `additionalContextLimit` is a cap on what a hook may inject, so the reminder
  has to fit inside it or be silently truncated -- find the default before
  step 11. `async` would suit the audit hook, which shells out to python.
- **Hook config entries also carry `enabled` and `trusted_hash`.** The
  installer may write `enabled`; it must never write `trusted_hash`, which is
  the host's own trust record (§9a).
- **`codex --help` documents `--dangerously-bypass-hook-trust`**, which runs
  enabled hooks without the persisted trust prompt. That makes step 16's smoke
  test possible without re-trusting on every edit. It is a testing affordance
  only -- the installer must never suggest it as a default, and the flag's own
  help text calls it DANGEROUS.

Tooling note, in the same spirit as §8f's `echo` trap: `grep` on this machine is
aliased to ugrep by rtk, and a pattern with two bounded `.{0,40}` windows failed
with `exceeds complexity limits` rather than returning no matches. A failed
search and an empty result read identically if the stderr is not checked. Check
it.

### 9i. Codex's hook wire format, from the embedded JSON Schema (step 11)

§9h read serde's concatenated field-name blob. That blob is the **union over
every struct in the module**, so it answers "which field names exist here" and
not "does event X carry field Y" -- and §9h drew a per-event conclusion from it.
The binary also embeds a draft-07 JSON Schema for the app-server protocol, and
*that* is authoritative for the **output** wire. Read 2026-09-17 from the same
296 MB binary as §9h, by dumping `strings -n 6` once to a file and re-grepping
the dump instead of paying a minute per query.

**The output wire is Claude Code's, down to the field names.**

    universal:   {continue, decision, hookSpecificOutput, stopReason,
                  suppressOutput, systemMessage, reason}

    SessionStart | UserPromptSubmit | SubagentStart
        hookSpecificOutput {hookEventName, additionalContext}
    PostToolUse
        hookSpecificOutput {hookEventName, additionalContext, updatedMCPToolOutput}
    PreToolUse
        hookSpecificOutput {hookEventName, additionalContext,
                            permissionDecision, permissionDecisionReason, updatedInput}

`PreToolUsePermissionDecisionWire` is `["allow","deny","ask"]`, verified from the
schema -- identical to Claude's `permissionDecision`, and camelCase. So
`injectContext()` and `denyToolCall()` port rather than being translated, and
§9c's rule holds verbatim. Exit codes are Claude-shaped too: the binary contains
"PreToolUse hook exited with code 2 but did not write a blocking reason to
stderr", so 2 blocks and the exit-0 discipline in `hosts/claude/main.ts`
transfers as-is.

**Events the schema names**, a superset of §9a's registered set: SessionStart,
SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest,
PreCompact, PostCompact, SubagentStart, SubagentStop, Stop. `Interrupt` is
genuinely absent, confirming §9h. And **there is no `PostToolUseFailure`** -- 0
occurrences in the binary. That is a Claude Code event, so the Claude adapter's
failed-call branch has no counterpart here and must not be invented.

**Correction to §9h: `cwd` IS in the hook input, and so is `tool_name`.** The
blob `session_id turn_id agent_type transcript_path cwd hook_event_name model
permission_mode trigger tool_name tool_input tool_use_id` is a PreToolUse-shaped
input struct. §9h sampled a session-level struct, which lacks `cwd`, and
generalised from it. There is still no *input* schema in the binary (only outputs
are schema'd), so the session-level events remain unconfirmed -- which means the
adapter must not depend on either answer:

- `tool_name` is available on the tool events, so call counting and the
  cheap-tool gate are the same code as on Claude Code.
- **Do not build step 12 on cwd's absence.** `hosts/codex/adapter.ts` reads
  `input.cwd` when it is there and falls back to `readRollout().cwd` from
  `session_meta`. One `??`, correct under both readings, and it also covers a
  `cwd` that is present but stale.

**`additionalContextLimit`** is on `HookHandlerConfig` and has no default in the
schema, so it is unset unless the installer writes one. Nothing to size against
yet; revisit at step 13.

**Step 11 landed.** `src/hosts/codex/{protocol,measure,adapter,main,index}.ts`,
13 tests in `test/hosts-codex.test.ts`, suite 262 -> 275, `tsc --noEmit` clean.
The context axis resolves `model_context_window` from the rollout with
`TOKEN_NORM_CONTEXT_LIMIT` unset, which is §9e in one assertion. `index.ts` is a
fifth file the §9b line did not name: step 15 imports each host's `main` through
it, and the Claude host already has one.

One trap worth naming, because the first version of the test fell into it: a
fixture with `input_tokens: 2000` beside `cached_input_tokens: 47000` is a record
that **cannot exist** -- §9g verified `cached <= input` in 1237/1237 records -- and
`tokensOf()` subtracts the breakdown, so fresh input floors at zero and the
window reads 48000 instead of 50000. Real rollouts respect the invariant; a
hand-written stub will not unless it is told to.
