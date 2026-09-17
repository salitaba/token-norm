# Rename plan

**Status: name decided (`token-norm`), execution not started.** Nothing has been
executed. The package, the repo, and the `bin` command all still carry the
current name.

Execution is blocked on two things that cannot be done from a working copy: an
npm login (`npm whoami` reports not logged in), and the GitHub repository rename.
Both are outward-facing and irreversible enough that they need a human at the
keyboard. See *Executing it* at the end of this document.

## Why

The name `opencode-token-norm` describes where the project started, not what it
does. The enforcement core is host-independent and now runs behind more than one
host adapter — OpenCode, Claude Code, with Codex partially built. A user on
Claude Code reading the package name reasonably concludes the plugin is not for
them, and the install command they need (`install --host claude`) suggests the
project is fighting its own name too.

This is the *plan* for fixing that. It is deliberately a separate document and a
separate piece of work from the docs re-framing that produced it, because a rename
touches npm, GitHub, CI, and every user's muscle memory, and cannot be done
partially without leaving the project in a worse state than it started.

## Surface

`opencode-token-norm` appears **160 times across 24 tracked files** (excluding
`package-lock.json` and `dist/`):

| File | Hits | Kind |
|---|---|---|
| `README.md` | 39 | badges, install commands, every doc URL |
| `CHANGELOG.md` | 21 | historical — **leave alone** |
| `scripts/install-local.mjs` | 16 | CLI, dry-run output, doctor output |
| `docs/promo.md` | 16 | launch copy |
| `docs/install.md` | 16 | install commands |
| `docs/RELEASING.md` | 7 | release workflow |
| `package.json` | 5 | `name`, `repository`, `bugs`, `homepage`, `bin` |
| `test/install-local.test.ts` | 3 | asserts on CLI strings |
| `docs/post-mortem.md`, `docs/audit.md`, `CONTRIBUTING.md` | 3 each | prose |
| `SECURITY.md`, `docs/screencast-script.md` | 2 each | prose |
| 10 further files | 1 each | CI, issue template, bench harness, `AGENTS.md` |

The rename is not a find-and-replace. The counts above mix four different kinds of
string, and only one of them should change.

## What must NOT be renamed

Getting this wrong is the main risk, and each item below is a deliberate,
previously-decided exception:

- **`TOKEN_NORM_*` environment variables.** Already host-neutral. Renaming them
  breaks every user's config for no benefit.
- **`token_norm_status` and `handoff`.** The tool names are already neutral, and
  `token_norm_status`'s payload is a documented public interface with a
  stability guarantee.
- **`~/.config/opencode/plugins/opencode-token-norm.js`.** Host-scoped by
  design — this path only ever exists on OpenCode, where the name is correct.
- **`~/.claude/token-norm/hook.mjs`.** Already neutral.
- **`~/.local/share/opencode/handoff` and `~/.local/share/opencode/token-norm.log`.**
  These carry `opencode` while being host-independent, which reads like a wart.
  It is deliberate: moving them would orphan every handoff note already on disk.
  Documented in [configuration.md](configuration.md).
- **`CHANGELOG.md` history.** Past entries describe past releases under the old
  name and must keep saying so. Add a new entry; do not rewrite old ones.

## What does change

1. The npm package `name`.
2. The GitHub repository name.
3. The `bin` command name.
4. Badges, doc URLs, and prose in current-facing docs.

## Naming

**Decided: `token-norm`.** It is the shortest option that still describes what
the thing is, it says nothing false about the host, and the package name is the
one string users type — the leading `opencode-` is the whole problem, so replacing
it with `agent-` only trades one qualifier for another.

Availability checked against the registry on **2026-09-17**:

| Candidate | `npm view <name> version` |
|---|---|
| `token-norm` | **free** |
| `agent-token-norm` | free |
| `token-norm-plugin` | free |
| `claude-token-norm` | free |
| `ai-token-norm` | free |
| `tokennorm` | free |

An empty result for every candidate was implausible enough to warrant a control,
so the same check was run against `react`, `express`, `typescript` and `vitest`,
which all resolved (`react -> 19.3.0`). `npm ping` returned PONG. The check is
therefore measuring the registry and not a silent network failure — `npm view`
returns empty for a missing package *and* for a dead connection, and the two are
indistinguishable without a control.

**A free name is not a guarantee of a successful publish.** npm applies
name-similarity rules at publish time and can reject a name that merely looks like
an existing package, which `npm view` will not reveal. `token-norm` sits close to
several existing `*-norm` packages, so treat publication as a distinct step to be
confirmed rather than a formality. Fall back to `agent-token-norm` (also free) if
the publish is rejected.

`@salitaba/token-norm` is the guaranteed-available fallback, since a scope cannot
collide — but it costs the short name and looks worse in an install command.

## Ordering

The order is not arbitrary — step 1 must precede step 2, or the deprecation shim
publishes with a repository field pointing at a URL that no longer resolves.

1. **Publish the new npm package** under the new name, with `repository` and
   `homepage` still pointing at the *current* GitHub URL (correct at this moment).
2. **Publish a deprecation release of the old package** — same version content,
   `npm deprecate opencode-token-norm "renamed to token-norm; install that instead"`,
   and a `bin` alias so `npx opencode-token-norm` keeps working during the window.
   Keeping both `bin` names live is what stops the rename from breaking anyone
   mid-flight.
3. **Rename the GitHub repository.** `github.com` URLs redirect automatically.
   This plan originally claimed `raw.githubusercontent.com` URLs do **not**, and
   that the README's two demo-asset URLs would therefore break. **That was
   wrong** — measured after the rename happened on 2026-09-17, the old raw URL
   still returns HTTP 200. Repoint them anyway so the docs do not depend on a
   redirect that is not formally guaranteed, but the front page was never at
   risk, and the ordering above is not as load-bearing as stated.
4. **Sweep badges, doc URLs and prose** in current-facing docs. Leave
   `CHANGELOG.md` history and the paths listed under *What must NOT be renamed*.
5. **Update CI** (`.github/workflows/release.yml`) and the issue template.
6. **Verify**, then remove the `bin` alias in a later release once the notice has
   had time to be seen.

## Verification

The rename is not done until all of these pass, on a machine that is not the one
the rename was authored on:

- `npx <new-name>` installs, and `doctor` reports ready — on **both** hosts
  (`--host claude` included).
- `npx opencode-token-norm` still resolves, during the deprecation window.
- `npm test` passes; note `test/install-local.test.ts` and `test/packaging.test.ts`
  assert on the package and CLI strings, so they must be updated in the same
  commit as `package.json` rather than after it.
- The rendered README shows the demo GIF (the raw-URL trap above).
- The old npm page shows the deprecation notice.

## Risks

| Risk | Mitigation |
|---|---|
| `raw.githubusercontent.com` asset URLs break silently | **Overstated — see the correction below.** Repointed anyway |
| Existing users' `npx opencode-token-norm` breaks | keep the `bin` alias through a deprecation window |
| Docs elsewhere (blog posts, package listings) point at the old name | the npm deprecation notice is the only lever; accept the tail |
| Renaming a path that holds user data | the *must not rename* list above is exhaustive — cross-check against it before every edit |
| Half-finished rename | land it as one commit plus one publish; do not split across sessions |

## Executing it

**This cannot be completed from a working copy, and was not attempted.** Two of
the steps are outward-facing and irreversible, and both need a human:

1. **`npm login`.** `npm whoami` currently reports not logged in, so no publish is
   possible. The publish is also the step most likely to fail for a non-obvious
   reason — see the name-similarity caveat above — so it wants a person watching
   the output, not a script.
2. **The GitHub repository rename.** Irreversible in the sense that matters:
   issue and PR numbers, clones, and every inbound link change behaviour at once,
   and `raw.githubusercontent.com` URLs stop resolving without redirect.

The order in *Ordering* above is load-bearing and should be followed literally.
Do not start with the repo rename because it is the visible one: doing so breaks
the README's demo assets and the old package's `repository` field before the
replacement is published.

Recommended handling: do this as its own session, with the name already settled
(it is — `token-norm`), and do not mix it with feature work. The mechanical sweep
is a find-and-replace across 24 files; the part that needs judgment is deciding,
file by file, which of the 160 occurrences are *the product name* and which are
*a host name or a user-data path*. That distinction is enumerated under *What
must NOT be renamed* and is the only real source of risk here.
