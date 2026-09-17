#!/usr/bin/env node
// Writes dist/provenance.json: which commit produced the shipped bytes, and
// what those bytes hash to.
//
// Why this exists: the package ships three files that run on a user's machine
// outside npm's own integrity story -- dist/plugin.js is copied into
// ~/.config/opencode/plugins by the installer, scripts/usage-audit.py is
// copied next to it and later executed, and dist/claude-hook.mjs is copied
// into ~/.claude/token-norm and then named in ~/.claude/settings.json, where
// Claude Code executes it once per hook event. Once copied they are loose files with
// no registry tarball behind them, so "is the plugin I am running the one that
// was released?" had no answer. Hashes recorded at build time, published in the
// tarball and in the GitHub release notes, give one.
//
// This lives in tools/ rather than scripts/ on purpose: scripts/ is shipped to
// users (see the "files" field), and build tooling is not a user-facing file.
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// Paths are relative to the package root so the recorded keys match what a
// consumer sees after unpacking the tarball.
const HASHED = ["dist/plugin.js", "dist/claude-hook.mjs", "scripts/usage-audit.py"]

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    // No git, or not a checkout -- e.g. rebuilding from an unpacked tarball.
    return null
  }
}

function resolveCommit() {
  // GITHUB_SHA is the fallback rather than the primary: locally there is no
  // such variable, and in CI it agrees with HEAD anyway.
  return git(["rev-parse", "HEAD"]) ?? process.env.GITHUB_SHA ?? "unknown"
}

function workingTreeDirty() {
  const status = git(["status", "--porcelain"])
  // Unknown provenance is not the same as clean, so refuse to claim clean when
  // git could not answer.
  if (status === null) return null
  return status.length > 0
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))

const artifacts = {}
for (const relative of HASHED) {
  const absolute = join(repoRoot, relative)
  if (!existsSync(absolute)) {
    console.error(`provenance: missing ${relative}\nrun \`npm run build:plugin\` first`)
    process.exit(1)
  }
  artifacts[relative] = sha256(absolute)
}

const provenance = {
  name: pkg.name,
  version: pkg.version,
  gitSha: resolveCommit(),
  gitDirty: workingTreeDirty(),
  algorithm: "sha256",
  artifacts,
}

const out = join(repoRoot, "dist", "provenance.json")
// Trailing newline so the file is diffable and `cat`-friendly.
writeFileSync(out, `${JSON.stringify(provenance, null, 2)}\n`)
console.log(`provenance -> ${out} (${provenance.gitSha.slice(0, 12)}${provenance.gitDirty ? ", dirty" : ""})`)
