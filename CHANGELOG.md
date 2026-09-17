# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Session state moved behind a store interface.** `budget/state.ts` kept its
  counters in a module-level `Map`, which is correct only while the process
  outlives the session — true for the OpenCode plugin, false for hosts whose
  hooks are a fresh process per tool call. It now uses `src/runtime/store.ts`,
  which offers an in-memory backend (what OpenCode keeps using, unchanged) and a
  disk backend that writes one JSON file per session atomically. No behaviour
  change: OpenCode takes the same path it always did.
- **Host-neutral modules moved under `src/core/`.** Config, logging, audit,
  usage, host event shapes and the whole budget policy layer now live there and
  import no host SDK. `status.ts` was split into `src/core/status.ts`
  (accounting) and `src/status.ts` (the OpenCode `tool()` wrapper).
- `doctor` reads the compiled config from `dist/core/config.js`, falling back to
  the pre-move `dist/config.js`, so it still reports settings against an older
  installed package.

### Added

- `TOKEN_NORM_STATE_DIR` overrides where session state is written. The default
  is `$XDG_STATE_HOME/token-norm/<host>` — state the program rebuilds on its
  own, so it belongs under the state directory rather than beside the handoff
  notes the user authored.

## [0.11.0] - 2026-09-12

### Added

- **`doctor` command.** `node scripts/install-local.mjs doctor` runs nine checks
  against a live install: Node >= 22, `opencode --version`, the package bundle
  being present, the sha256 of the installed plugin against `dist/plugin.js`,
  the audit script being readable, the settings (imported from `dist/config.js`
  via `takeConfigDiagnostics()`), `python3`, the OpenCode database being
  readable, and duplicate plugin registration in `opencode.json`. It exits 1
  only on a `fail`; a `warn` is reported and still exits 0, so it can gate a
  script without failing on the merely unusual.
- **`--dry-run` on `install` and `uninstall`.** Prints the file operations that
  would run and touches nothing. The preview and the real run read the same
  `plan()`, so the two cannot drift. The argv parse was rewritten to filter
  `--` flags rather than reading `process.argv[2]`, which is what makes
  `uninstall --dry-run` work rather than being read as an unknown command.

### Documentation

- **The `token_norm_status` payload is declared a public interface.** Stable
  within a major version, `peak >= current` always, and reads are
  side-effect-free — stated in `docs/how-it-works.md` above the payload example
  and in the README. No field changed; this documents the existing contract.
- `docs/install.md` shows a `--dry-run` example and replaces the "check it
  loaded" section with annotated `doctor` output, explaining what the sha256
  and settings checks actually prove.

### Internal

- 29 new tests. `test/contract.test.ts` is new and asserts behavioral
  contracts through the plugin hooks: a throwing audit, a throwing toast, an
  async-rejecting toast and an exploding provider all leave the tool call
  intact; compaction recovery drops `current` to `HEALTHY` while `peak` holds
  `PRESSURE`; status reads never latch the peak; block mode keeps the handoff
  and cheap tools open even at 50000x over limit; and pressure alone never
  blocks. `test/install-local.test.ts` grew to 15 tests covering the new
  command surface, including exit codes.

## [0.10.0] - 2026-09-12

### Added

- **`token_norm_status` reports `policy.current`, `policy.peak` and
  `policy.driver`.** `current` is severity at this instant and may fall;
  `peak` is the session high-water mark and never does; `driver` names the axis
  (`calls`, `budget`, `context`) behind `current`. Additive: the top-level
  `state` field remains, now documented as a deprecated alias of `policy.peak`,
  and `recommendation` is still derived from the peak. The snapshot enforces
  `peak >= current` itself, so a stale stored level cannot produce an
  inconsistent payload.
- **Executable invariants for the policy machine.** Idempotence, `BLOCKED` only
  under `block` mode with a hard limit exceeded (and always, then),
  `HANDOFF_RECOMMENDED` only under `handoff` mode with pressure and an armed
  pause (and always, then), observe/warn measuring identically, state never
  below the axis max, and at most one rendered block with exactly one header for
  every subset of due sections — each checked over the whole reachable input
  space rather than on hand-picked examples.

### Fixed

- **The driver axis at `HEALTHY` is no longer reported as `context`.** The
  most-specific-first rule matched every axis when nothing was wrong, so a
  healthy session — including one whose context window could not be resolved at
  all — named context as its driver. It now attributes to the calls axis, which
  always exists.

### Documentation

- README leads with the positioning, the checkpoint ladder, and a
  before/after; adds an enforcement-mode table, a Node/OpenCode/plugin
  compatibility row, and splits evidence into observed / benchmark / hypothesis
  (including the retracted wall-time finding: +2.6 s, p = 0.83).
- `docs/how-it-works.md` documents the status payload field by field, the
  `current` vs `peak` distinction, weighted vs raw call counts (why
  `calls 37` and `budget.toolCalls: 52` are both right), the
  measurement → policy → rendering pipeline, and a call-by-call session
  walkthrough.
- Process-local state is stated as an explicit guarantee in the README, and
  `effective fresh tokens` is called out as cost-weighted input rather than a
  provider token total.

## [0.9.0] - 2026-09-12

### Added

- **Weighted tool-call budgets.** `TOKEN_NORM_TOOL_WEIGHTS` and
  `TOKEN_NORM_PHASE_WEIGHTS` accept `name=weight` comma lists (positive numbers;
  unlisted names weigh 1), so a `bash` call can cost more than a `read`, or a
  planning-mode call less than a build-mode one. Phase is the latest assistant
  message mode, resolved per step through `messageID` with a session-latest
  fallback. A malformed entry is dropped, weighs 1, and reports into the config
  diagnostics.

### Changed

- **`TOKEN_NORM_MAX_TOOL_CALLS` now compares weighted calls** (tool weight ×
  phase weight; cheap tools still contribute nothing) and the metric is labeled
  "Weighted tool calls". Raw call counts continue to drive the announce, audit,
  and task-boundary thresholds and the policy call-count axis, so weights can
  never delay or advance a reminder.

## [0.8.0] - 2026-09-12

### Fixed

- **Benchmark harness no longer charges the treatment arm for a cold plugin
  install.** Loading a plugin makes opencode npm-install `@opencode-ai/plugin`
  into `XDG_CONFIG_HOME/opencode`, and `bench/run.mjs` gives every run a fresh
  `HOME` and config dir, so that install ran from scratch on every run: **66.7 s**
  measured via `opencode debug config`. Both arms install, but only on treatment
  does it block startup, where it was published as plugin wall-time overhead.
  Seeding the npm cache alone still costs 9.2 s, so the harness now resolves the
  tree once per invocation and hardlinks `node_modules` + `package.json` +
  `package-lock.json` into each run's config dir for **both** arms before
  `opencode` starts. Verified: the plugin-load window drops to **0.213 s**,
  inside the baseline range. The re-run is complete
  (`power-string-sweep-v2.jsonl`, 40/40, $0.2923): window **0.158 s vs 0.278 s**
  per arm, wall difference **+2.6 s, p = 0.83** — was +27.4 s, p = 0.018. No
  wall-time separation remains.

- `session.deleted` events missing `info.id`, and user messages missing
  `sessionID`, no longer throw into the event handler's catch-all (which also
  skipped handoff arming and the task-boundary check for that event).

### Changed

- **Benchmark wall-time claim corrected: harness artifact, not plugin cost.**
  `docs/benchmark.md` reported the power study's only significant separation as
  wall time, +27.4 s per run in the treatment arm (p = 0.018). A paired per-run
  decomposition of all 40 runs (from each record's preserved `run_dir` — the
  session DB for message/tool timings, the opencode log for phase boundaries)
  shows the gap is entirely startup, and inside startup it is one window:
  plugin loading, baseline mean 0.25 s vs treatment 23.22 s. Cause is the
  harness's per-run `HOME` isolation — only the treatment arm loads a plugin, so
  only it blocks on the plugin dependency install during startup (npm, not bun;
  see Fixed above). Plugin runtime is not involved: importing `dist/plugin.js`
  costs 0.24 s under bun, the tool hook 0.004 ms, the audit spawn ~45 ms.
  Adjusted for that window the difference is +4.45 s, paired positive in 13 of
  20 rather than 17 of 20 — superseded by the fixed-harness re-run at
  **+2.6 s, p = 0.83**.
- **README first screen.** The install command moved from line 69 to line 19.
  Badges cut from seven to three (version, test, license), the hand-written
  table of contents dropped in favour of GitHub's own heading outline, the
  duplicated handoff statistic removed (the same numbers are in
  `## Observed behavior`), the demo caption folded into the intro paragraph, and
  the before/after diagram relocated to `docs/how-it-works.md`, next to the
  architecture diagram it belongs with. No content was lost, only moved or
  de-duplicated.
- **Unified policy state machine.** Severity is now computed once, in
  `src/budget/policy.ts`, as a monotone state machine
  (`HEALTHY` < `ATTENTION` < `PRESSURE` < `HANDOFF_RECOMMENDED` < `BLOCKED`)
  over three axes -- call count, configured budgets, and the context window.
  The mode is applied after the max, not inside an axis. Previously eight
  independent decision sites in the tool hook each owned a threshold and a
  latch, which allowed three separate `<system-reminder>` blocks and two toasts
  on a single tool call. The plugin now emits **at most one block per tool
  call**, with a state header naming the driving axis and a fixed section
  order: boundary, announce, audit, budget, handoff. At most one toast, titled
  by state.
- **Reminders no longer suppress each other.** The early returns after the
  task-boundary and announce reminders are gone. Deferral was a side effect of
  those returns rather than a design goal: it spread co-occurring thresholds
  across separate tool calls and skipped the budget check entirely on those
  calls. Everything due on a call now lands together in the one block.
- **`token_norm_status` answers from the enforcement machine.** The `recommend()`
  ladder in `src/status.ts`, which re-derived severity from
  `(pressured, exceeded, mode)`, is replaced by a direct state map. The snapshot
  gains a `state` field alongside `recommendation`. Two visible contract
  changes: a session at or past `TOKEN_NORM_ANNOUNCE_AT` with no budget
  pressure now reports `warn` where it reported `continue`; and in handoff mode,
  pressure *without* a pause now reports `warn` rather than `handoff`, matching
  what the plugin would actually do -- a handoff has always required a natural
  pause as well.

- `TOKEN_NORM_SETTLE_MS` and `TOKEN_NORM_SWITCH_WAIT_MS` are read in `config.ts`
  like every other setting, so they are validated and diagnosed too.
- The opencode client and event payloads are no longer typed as `any`. `src/host.ts`
  declares narrow interfaces covering only the host fields this plugin actually
  reads, so a renamed or removed host method now fails at build time instead of
  disappearing into a runtime catch.

### Added

- **Release provenance.** Every build writes `dist/provenance.json` recording the
  `gitSha` it was built from, whether the working tree was dirty, and the sha256
  of both files that leave npm's integrity story once installed --
  `dist/plugin.js` and `scripts/usage-audit.py`. The installer copies those two
  into `~/.config/opencode`, where nothing else attests to them and the audit
  script is then executed. The digests ship in the tarball, are rendered as a
  table in the GitHub release notes, and `provenance.json` is attached as a
  release asset, so an installed copy can be checked with `shasum -a 256`.
  `test/packaging.test.ts` rehashes the packed bytes, so a stale or wrong
  digest fails the build rather than shipping.
- Config diagnostics: a malformed or misspelled `TOKEN_NORM_*` setting is
  reported once at load (log line plus a toast) instead of silently falling back
  to its default. Covers non-numeric or non-positive thresholds and budgets, an
  out-of-range `TOKEN_NORM_CONTEXT_WARN`, a kill switch set to anything but `0`
  or `1`, an empty `TOKEN_NORM_CHEAP_TOOLS`, and unrecognized `TOKEN_NORM_*`
  keys. Values still fall back rather than failing the session.
- Handoff integration-test matrix: child-session events, a late `session.created`,
  the settle floor, `appendPrompt`/`submitPrompt` failures, and concurrent
  handoffs.
- Benchmark statistics: per-cell summaries now carry `n`, `median`, `sd`, and a
  seeded bootstrap 95% CI for the mean, plus a per-task treatment-vs-baseline
  contrast using a two-sided permutation test. Cells below five runs per arm are
  flagged `underpowered` so a small batch cannot be read as a result.
- `bench/run.mjs --resummarize <jsonl>` recomputes a summary from existing run
  records with no paid runs and without writing to the input file.
- Power study (`bench/results/power-string-sweep.jsonl`, 40 paid runs, n=20 per
  arm) refuting the earlier N=2 `10-string-sweep` hypothesis: tool calls differ
  by -3.05 (p = 0.65) and both arms are bimodal. Wall time is the one metric that
  separates, +27.4 s in the treatment arm (p = 0.018), cause unattributed.

## [0.7.2] - 2026-09-11

### Fixed

- Deleted-session suppression survives eviction: an id evicted from the bounded
  deleted window could be resurrected by a late `step-finish`, re-counting spend
  already folded into its parent. Deleted ids are now also recorded in a
  fixed-size filter with no false negatives, and a live-entry check lets a
  restarted `session.created` through. Adds the seeded usage-ledger invariant
  suite (`test/budget-state.invariants.test.ts`) covering the eviction
  regression.

## [0.7.1] - 2026-09-11

### Added

- Event-order tests for the budget plugin (`test/event-order.test.ts`): reminder
  priority within a single call (boundary > announce > audit, each suppressed
  reminder deferred to the next call), boundary injection points across an
  interleaved event stream, counter and step-usage alignment through
  `token_norm_status`, and handoff arming order (a pause before pressure does
  not arm; a pause after pressure does).

## [0.7.0] - 2026-09-11

### Added

- Medium and long benchmark fixtures (`03-many-bugs`, `04-long-sweep`), per-call
  timing metrics (`gap`, `exec`) in the harness, and the pilot 2 write-up with a
  provider-free latency microbench in `docs/benchmark.md`.

### Changed

- `token_norm_status` now labels its scopes: `budget` (`toolCalls`, `cost`,
  `effectiveTokens`) rolls up the session tree, while `session.context` is the
  current session's window. The JSON shape changed accordingly:
  `session.toolCalls` moved to `budget.toolCalls`, and both groups carry a
  `scope` field, so the tree rollup is no longer ambiguous.
- The status provider is injected per plugin instance via
  `createStatusTool(provider)` instead of a module-global registry, so two
  plugin instances in one process can no longer shadow each other's reader.

## [0.6.0] - 2026-09-11

### Added

- `token_norm_status`: a read-only tool that reports the session's tool calls,
  context usage, cost and effective tokens against the configured limits, plus
  the `continue | warn | handoff | block` recommendation enforcement would give
  right now. It reads the same accumulators as the reminders, so the two cannot
  disagree; unknown sessions report zeros, and the tool is absent when the
  budget plugin is not loaded.
- Benchmark harness (`bench/run.mjs`) with two fixture tasks, plus the pilot
  methodology and results write-up in `docs/benchmark.md`.

## [0.5.3] - 2026-09-11

### Fixed

- Child-session rollups no longer stop at a fixed 20-level depth: `rootOf`
  walks parent links to the true root, with a cycle guard instead of a cap.
- `session.deleted` aggregates instead of tombstoning: the deleted session's
  totals fold into its parent and the entry is dropped, so a long-lived server
  keeps no ledger entry per deleted session. Live children reparent to the
  grandparent, and a bounded window of deleted ids still swallows late events.
- Documented that the model context-limit cache lives for the process: provider
  config changes need a restart or `TOKEN_NORM_CONTEXT_LIMIT`.

## [0.5.2] - 2026-09-11

### Fixed

- `handoff` disarms its session-switch waiter on every exit path, not just the
  timeout: a thrown `executeCommand` or any other error now clears it via
  `try/finally`, so a late `session.created` can no longer satisfy a stale
  resolver and clear the next handoff's waiter before its own session exists.
- README no longer claims the plugin "adds no advice"; the accurate claim is
  that it does not rely on agent-authored advice as its enforcement mechanism.

## [0.5.1] - 2026-09-11

### Fixed

- `session.deleted` no longer un-spends the subtree: the session retires to a
  totals-only tombstone (linkage kept, history/detail freed) so root rollups
  and `block` enforcement keep counting real spend. Live grandchildren stay
  reachable through the tombstone. Late step/tool events for a deleted session
  are ignored instead of double-counting.
- README/design no longer claim the plugin never blocks: default never blocks,
  `block` mode is opt-in. Node row now matches the CI matrix (22, 24).

## [0.5.0] - 2026-09-11

### Added

- Measured budgets from provider `step-finish` events (cost, input/output/cache tokens), not just tool-call counts: `TOKEN_NORM_MAX_COST`, `TOKEN_NORM_MAX_EFFECTIVE_TOKENS`, `TOKEN_NORM_MAX_TOOL_CALLS`, and `TOKEN_NORM_CONTEXT_LIMIT`. The first crossing of each metric staples a status block onto tool output; cost/tokens/calls roll up across subagent sessions.
- `TOKEN_NORM_MODE` enforcement modes: `warn` (default, injects the status block), `observe` (logs crossings only, injects nothing), `handoff` (adds a skeleton at the next pause once over budget), and `block` (opt-in; refuses non-cheap tool calls while over budget — cheap tools and `handoff` stay available as the escape hatch).
- Context pressure: current window relative to the model's context limit, resolved from the client's provider config or overridden with `TOKEN_NORM_CONTEXT_LIMIT`; threshold `TOKEN_NORM_CONTEXT_WARN` (default `0.8`).
- Handoff recommendations include estimated attribution from output bytes (top tools, repeated reads, images) and touched files pre-filled from edit/write/patch tool args.

## [0.4.1] - 2026-09-11

### Fixed

- `handoff` no longer treats an untimed `session.created` event as the fresh session: events whose `time.created` is not a number are rejected as unverifiable, and the bounded timeout fallback still appends. Fixes a race where the handoff note could be appended to the wrong session.

### Added

- `docs/compatibility.md`: per-build compatibility matrix and runtime assumptions, linked from the README and smoke-test docs.

### Changed

- README: troubleshoot the one-command install — the npx-from-a-repo-clone resolution gotcha, offline/global fallbacks, and post-restart checks.

## [0.4.0] - 2026-09-10

### Added

- One-command install: `npx opencode-token-norm` copies a self-contained plugin bundle and the audit script into `~/.config/opencode/`; `npx opencode-token-norm uninstall` removes them. It installs as a local plugin file because OpenCode builds ≥ 1.17 can silently skip npm-spec plugins ([opencode#48379](https://github.com/anomalyco/opencode/issues/48379)); verified end to end on 1.18.30.
- `npm run install:local` for development checkouts: rebuilds the bundle and reinstalls it.

### Changed

- README install is the one-command `npx` flow. `opencode plugin opencode-token-norm --global` is documented as equivalent once npm-spec loading is fixed.

## [0.3.0] - 2026-09-10

### Changed

- `handoff` now submits the fresh session by default. The new session opens with the handoff note pre-filled in the prompt, so the user only has to press enter. Pass `submit: false` to keep the prompt unsubmitted.

## [0.2.1] - 2026-09-10

### Fixed

- `usage-audit.py` is now scoped to the current session when invoked by the plugin, and handles XDG paths and cost output correctly.

### Added

- Single-command install documented in the README.
- Demo recording tooling and assets under `docs/`.
- Sample session receipt in the README.

## [0.2.0] - 2026-09-10

### Added

- Shareable session receipt in `usage-audit.py`.
- Marketing and positioning docs.

## [0.1.0] - 2026-09-09

### Added

- Initial release: `TokenNormBudget`, which counts tool calls and staples reminders at thresholds, and `TokenNormHandoff`, which collapses the session split into a single tool call.

[Unreleased]: https://github.com/salitaba/token-norm/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/salitaba/token-norm/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/salitaba/token-norm/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/salitaba/token-norm/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/salitaba/token-norm/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/salitaba/token-norm/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/salitaba/token-norm/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/salitaba/token-norm/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/salitaba/token-norm/compare/v0.5.3...v0.6.0
[0.5.3]: https://github.com/salitaba/token-norm/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/salitaba/token-norm/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/salitaba/token-norm/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/salitaba/token-norm/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/salitaba/token-norm/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/salitaba/token-norm/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/salitaba/token-norm/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/salitaba/token-norm/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/salitaba/token-norm/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/salitaba/token-norm/releases/tag/v0.1.0
