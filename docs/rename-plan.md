# Rename plan

**Status: proposed, not started.** Nothing in this document has been executed.
The package, the repo, and the `bin` command all still carry the current name.

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

**Not yet decided, and this is the first thing to settle.** Requirements:
lowercase, hyphenated, no scope if avoidable, and it must not lie about the host.

| Candidate | Note |
|---|---|
| `token-norm` | cleanest, but almost certainly taken — must be checked |
| `agent-token-norm` | descriptive, likely free, slightly long |
| `@salitaba/token-norm` | scope guarantees availability; costs the short name |

Check availability before anything else:

```sh
npm view <candidate> version   # exit 0 means taken
```

Nothing else in this plan can be costed until the name is chosen, because the
`npx` commands in every doc depend on it.

## Ordering

The order is not arbitrary — step 1 must precede step 2, or the deprecation shim
publishes with a repository field pointing at a URL that no longer resolves.

1. **Publish the new npm package** under the new name, with `repository` and
   `homepage` still pointing at the *current* GitHub URL (correct at this moment).
2. **Publish a deprecation release of the old package** — same version content,
   `npm deprecate opencode-token-norm "renamed to <new>; install that instead"`,
   and a `bin` alias so `npx opencode-token-norm` keeps working during the window.
   Keeping both `bin` names live is what stops the rename from breaking anyone
   mid-flight.
3. **Rename the GitHub repository.** `github.com` URLs redirect automatically;
   `raw.githubusercontent.com` URLs **do not**. The README embeds two raw asset
   URLs for the demo GIF and MP4, so those must be repointed in the same commit
   or the front page loses its demo.
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
| `raw.githubusercontent.com` asset URLs break silently | repoint in the same commit as the GitHub rename; check the rendered README |
| Existing users' `npx opencode-token-norm` breaks | keep the `bin` alias through a deprecation window |
| Docs elsewhere (blog posts, package listings) point at the old name | the npm deprecation notice is the only lever; accept the tail |
| Renaming a path that holds user data | the *must not rename* list above is exhaustive — cross-check against it before every edit |
| Half-finished rename | land it as one commit plus one publish; do not split across sessions |
