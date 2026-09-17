# Contributing

Thanks for taking the time to contribute to opencode-token-norm.

## Development setup

Requires Node.js 22 or newer.

```bash
git clone https://github.com/salitaba/opencode-token-norm.git
cd opencode-token-norm
npm install
npm run build
```

- `npm run typecheck` type-checks without emitting.
- `npm test` runs the Vitest suite: threshold reminders, boundary dedupe, and handoff semantics.
- `npm run build` emits `dist/` (gitignored; CI builds it on release).

## Project layout

`src/core/` is host-neutral: it imports no host SDK, takes numbers in and
returns text out. Everything outside it knows what an OpenCode plugin is. Keep
that line intact — it is what lets the same policy run under other hosts.

| Path | Contents |
| --- | --- |
| `src/index.ts` | Plugin entrypoint and exports |
| `src/session-budget.ts` | Re-export of the budget plugin |
| `src/budget/plugin.ts` | Tool-call counting and threshold reminders (OpenCode-bound) |
| `src/handoff.ts` | The `handoff` tool |
| `src/status.ts` | The `tool()` wrapper around `src/core/status.ts` |
| `src/core/audit.ts` | Usage audit integration |
| `src/core/config.ts`, `src/core/log.ts` | Config and logging helpers |
| `src/core/usage.ts`, `src/core/host.ts` | Token accounting and host event shapes |
| `src/core/budget/` | Policy, evaluation, reminders, and session state |
| `src/runtime/store.ts` | Session-state backends: in-memory and disk |
| `scripts/usage-audit.py` | Session usage/cost audit |
| `test/` | Vitest regression tests for thresholds, boundaries, and handoff |
| `docs/RELEASING.md` | Release process (maintainers) |

## Making changes

1. Fork the repo and create a branch from `main`.
2. Keep each pull request focused on one change.
3. Follow the existing commit style: `feat:`, `fix:`, `docs:`, `chore:`.
4. Run `npm run typecheck`, `npm test`, and `npm run build` before opening a pull request.
5. Add user-facing changes to `CHANGELOG.md` under `## [Unreleased]`; maintainers move them into a version section at release time.
6. Describe how you tested the change in OpenCode. For changes touching the event hooks or `handoff.ts`, run [the manual smoke test](docs/smoke-test.md) against a real OpenCode build — the unit suite mocks that runtime on purpose.

## Reporting issues

Use the issue templates. For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
