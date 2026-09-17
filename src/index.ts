import type { Plugin } from "@opencode-ai/plugin"
import { BUDGET_ENABLED, HANDOFF_ENABLED } from "./core/config.js"
import { SessionBudgetPlugin } from "./session-budget.js"
import { HandoffPlugin } from "./handoff.js"

const noop: Plugin = async () => ({})

// Both halves are exported so a user can load one without the other, and both
// respect an env kill switch so opting out never requires uninstalling.
export const TokenNormBudget: Plugin = BUDGET_ENABLED ? SessionBudgetPlugin : noop
export const TokenNormHandoff: Plugin = HANDOFF_ENABLED ? HandoffPlugin : noop
