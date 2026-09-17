// The opencode-facing half of status: the tool() wrapper.
//
// Everything the wrapper reports is computed in core/status.ts, which imports
// no host SDK. Only this file knows what a tool is, so only this file has to be
// rewritten per host -- a Claude Code or Codex adapter renders the same
// StatusSnapshot through its own mechanism and shares the accounting verbatim.

import { tool } from "@opencode-ai/plugin"
import { readStatus, renderStatus, type StatusProvider } from "./core/status.js"

export * from "./core/status.js"

export function createStatusTool(provider?: StatusProvider) {
  return tool({
    description: [
      "Report token-budget accounting as machine-readable JSON. budget",
      "(toolCalls, cost, effectiveTokens) rolls up the whole session tree -- root",
      "plus descendant sessions; session.context is the current session's window",
      "only. Each metric is { used, limit }, limit null when unconfigured.",
      "policy.current is severity right now and can fall; policy.peak is the",
      "highest this session has reached and never decreases; policy.driver names",
      "the axis (calls | budget | context) behind current. States are HEALTHY,",
      "ATTENTION, PRESSURE, HANDOFF_RECOMMENDED, BLOCKED. recommendation is",
      "continue | warn | handoff | block, derived from peak. Top-level `state`",
      "is a deprecated alias of policy.peak.",
      "",
      "Use before starting a large task, when the user asks what the session has cost,",
      "or to check whether the token-norm plugin would warn, hand off, or block now.",
      "Read-only; unknown sessions report zeros.",
    ].join("\n"),
    args: {},
    async execute(_args, ctx) {
      const snapshot = await readStatus(provider, ctx.sessionID)
      return {
        title: `Token status (${snapshot.recommendation})`,
        output: renderStatus(snapshot),
        metadata: { recommendation: snapshot.recommendation },
      }
    },
  })
}
