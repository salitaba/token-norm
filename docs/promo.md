# Launch & promo copy

Reference copy for announcing `opencode-token-norm`. Not shipped in the npm tarball
(`package.json` `files` whitelists `dist`, `scripts`, `README.md`, `LICENSE`).

## Status

| Target | Link | State |
| --- | --- | --- |
| npm | https://www.npmjs.com/package/opencode-token-norm | published `0.2.1` |
| GitHub | https://github.com/salitaba/token-norm | public |
| Release | https://github.com/salitaba/token-norm/releases/tag/v0.2.1 | tagged |
| opencode ecosystem PR | https://github.com/anomalyco/opencode/pull/48182 | open, awaiting review |
| awesome-opencode PR | https://github.com/awesome-opencode/awesome-opencode/pull/693 | open, awaiting review |
| Discord `#community-projects` | https://opencode.ai/discord | posted |
| r/ChatGPTCoding | https://www.reddit.com/r/ChatGPTCoding/comments/1wch7su/my_agent_ran_its_own_token_audit_reported_bloat/ | submitted `Resources And Tips`; AutoMod held for manual review (account karma). Do NOT delete/repost — modmail after 24h |
| r/LocalLLaMA | — | blocked: sub-karma gate, 0 karma |
| X / HN | — | copy below, unposted |

## Positioning

Lead with the **enforcement mechanism**, not the handoff.

`opencode-handoff` (joshuadavidthomas) and `opencode-session-handoff` (bristena-op)
already exist and overlap the handoff half by roughly 70%. Pitched as a handoff
plugin this loses to the incumbent. The budget enforcement half has no ecosystem
equivalent; handoff is bundled as the escape hatch the reminders point at.

Three concrete hooks, all backed by real sessions:

- A 184-call, 3.0M effective-token session where the norm was in context the whole time.
- At 195k deep the agent ran the audit, reported 77x cache / bloat HIGH, and continued
  anyway — because a `do everything` override from task 1 silently carried into task 2.
  Per-task override expiry is the unique feature.
- An early version fired the boundary reminder 61 times for one user message; dedupe
  compared a call count instead of message identity. Reminders that repeat become
  wallpaper and the agent learns to skip all system-reminders. Now deduped on message id.

## Discord post (#community-projects)

Post in `#community-projects` — the dedicated share channel. Not `#general` (buried),
not `#dev` / `#experimental` (core development), not `#agents` (agent config).
`#announcements` and `#releases` are maintainer-only broadcast. Read `#rules` first for
a self-promo or membership-age gate. Do not cross-post; that reads as spam.

Discord caps messages at 2000 characters. The copy below is ~1050. Paste verbatim,
dropping the `> ` quote markers (they are markdown quoting here, not part of the post).
Keep the URL last so the link preview renders at the bottom.

Writing notes, in case this needs a rewrite: lead with the paradox (the agent already
knows and continues anyway), not autobiography. Bullets end in consequences, second
person. No preemptive bug confession — the 61-reminders story below is reply ammo, and
lands far harder as an answer to "how is this not annoying" than as part of the pitch.

Keep the unhappy path out of the pitch entirely. No off switches, no caveats, no
"in case you don't like it". Raising an objection nobody made plants the doubt it
answers. Uninstall instructions, env vars, and limitations belong in the README, where
someone who already wants the thing goes looking. Same reason the bug story is held
back: the pitch sells the happy path, replies handle everything else.

End on the link. No closing question fishing for replies — it reads as soliciting, and
a coined term in the last line ("the stale-override thing") lands on readers who skimmed
the bullets and never met the term. The bullets carry the argument; let them.

> **opencode-token-norm**
>
> Your agent already knows it's burning your context. Mine told me: ran the audit, reported the bloat, then kept right on going for another 90k tokens.
>
> Knowing isn't stopping. Rules in AGENTS.md are knowing. This is stopping.
>
> What it does:
> - watches your tool calls and interrupts the agent when you cross a budget — it can't miss the reminder, it arrives attached to the output it's already reading
> - pulls the real usage numbers itself, so the checkpoint isn't "agent, please go look"
> - expires "just do everything" when that task ends, so a blank cheque you wrote an hour ago can't fund the next three tasks
> - `handoff` tool for when you should start over: dumps state to disk, opens a clean session pre-filled, you keep the conclusions and bin the 80k of tool spam that produced them
>
> ```
> npm i opencode-token-norm
> ```
> Add to `plugin` in opencode.json.
>
> https://github.com/salitaba/token-norm

### Held back for replies

Use when someone asks how the reminders avoid becoming noise:

> An early version fired the boundary reminder 61 times for one user message — the dedupe
> compared a call count instead of message identity. Repeated reminders become wallpaper,
> and worse, the agent generalizes and starts skipping *every* system-reminder. Deduped on
> message id now.

## Reddit self-post (r/LocalLLaMA, r/ChatGPTCoding)

r/LocalLLaMA gates on *subreddit* karma (0 karma = blocked); earn it by commenting
there for a couple of weeks before posting. r/ChatGPTCoding allows this under rule 6
(rule 5 routes AI coding projects to it), but rule 6 demands problem + comparison
*with numbers* + what you did including what didn't work. Flair must be
`Resource and Tips` — rule 6 names it explicitly. The comparison section below exists
to satisfy that rule; do not drop it. Conceding the handoff half to the incumbents is
load-bearing, not modesty: it also pre-empts the "this already exists" top comment.

**Title:** My agent ran its own token audit, reported "bloat HIGH" at 195k tokens, and kept going anyway — so I stopped asking it nicely

I write agent instructions for a living lately, and I had a token-discipline norm loaded in every session: size the task first, state the expected cost, split at phase boundaries, run the audit on long jobs.

It did not work, and the way it failed is the interesting part.

**Failure 1 — presence isn't enforcement.** A 184-call session, 3.0M effective tokens. The norm was in context the entire time. Instructions compete with the task in flight, and the task always wins, because the task is what the user just asked for and the norm is what the user asked for weeks ago.

**Failure 2 — the audit is advice.** I added "run the usage audit at checkpoints." At 195k the agent ran it, reported 77x cache ratio and bloat HIGH... and kept going. Reporting a number is not the same as acting on it.

**Failure 3 — overrides leak.** That session continued because I'd said "do everything, don't ask" for task 1, and the grant silently carried into task 2. Nothing revoked it. Nothing was supposed to.

So I wrote a plugin that does the parts prose can't do:

- It counts tool calls and **staples a `<system-reminder>` onto tool output** when you cross the threshold. Not a hope that the agent checks — an interrupt in the channel it's already reading.
- It **runs the audit itself** and injects the numbers into that reminder.
- **Per-task override expiry.** A "do everything" grant is scoped to the request that granted it. A new request naming new files is a new task, and the override is gone. This is the piece I haven't seen anywhere else.
- Cheap tools (todo, question, skill) don't count toward the budget, so bookkeeping doesn't trip the alarm.
- A bundled `handoff` tool for the escape hatch: write the note to disk *first*, then open a fresh session with the note pre-filled. Findings are small and survive a handoff; the 80k of tool output that produced them does not.

**Closest existing solutions.** Two opencode handoff plugins already ship: `opencode-handoff` (0.5.0) and `opencode-session-handoff` (1.1.6). They cover session switching well and overlap maybe 70% of the handoff half of mine. I don't beat them at it — if handoff is all you want, use theirs, they've been at it longer.

What I couldn't find an equivalent for is enforcement. Every option I looked at, including my own prose norm, is something the agent has to *choose* to consult. Numbers from the session that made me stop writing prose: 184 tool calls, 3.0M effective tokens, 77x cache ratio, the norm in context for every one of those calls. The default threshold here fires at 25 calls and re-fires every 60 — that same session would have been interrupted 7 times before reaching the point where the agent audited itself and shrugged.

**What didn't work.** Sharper prose was the first thing I tried, and it changed nothing — a stronger instruction is still an instruction, and it still loses to the task in flight. The second dead end was a bug I shipped. An early version fired the boundary reminder **61 times for a single user message**, because the dedupe compared a call count instead of message identity. That's worse than it sounds: repeated reminders become wallpaper, and the agent generalizes from "this one is noise" to ignoring the entire `system-reminder` channel — including the ones that matter. If you inject anything into an agent's context, dedupe on message identity, not on a counter, and treat your injection budget as finite.

It's for opencode: `npm i opencode-token-norm`. MIT.
https://github.com/salitaba/token-norm

Curious whether anyone has solved the override-expiry problem differently — "do everything" leaking across task boundaries feels like it should bite every agent harness, not just mine.

## X / Twitter thread

**1/**
I kept a token-discipline rule in my agent's system prompt for weeks.

Then I watched a 184-call, 3.0M-token session run with that rule in context the whole time.

Instructions don't enforce. Code does. So:

**2/**
The moment I gave up on prose:

At 195k tokens deep, the agent ran the usage audit, reported "77x cache ratio, bloat HIGH"...

and continued anyway.

Reporting a number ≠ acting on it.

**3/**
Root cause was worse. I'd said "do everything, don't ask" for task 1.

That override silently carried into task 2. Nothing revoked it. Nothing was designed to.

**4/**
opencode-token-norm does the parts an instruction can't:

• counts tool calls, staples a system-reminder onto tool output at the threshold
• runs the audit itself, injects the numbers
• overrides expire with the task that granted them
• bundled handoff tool as the escape hatch

**5/**
Bug I shipped and fixed, generally useful:

v0 fired the reminder 61 times for ONE user message. Dedupe compared a call count, not message identity.

Repeated reminders become wallpaper — and the agent learns to skip *all* system-reminders.

Dedupe on message id.

**6/**
`npm i opencode-token-norm`
MIT, for @opencodeai

https://github.com/salitaba/token-norm

## Hacker News

**Title:** Show HN: Token budget enforcement for coding agents that fires without being asked

I had a token-discipline norm loaded into my coding agent's context every session — size the task, state the cost, split at phase boundaries, run the audit. It was ignored through a 184-call, 3.0M effective-token session.

The instructive failure wasn't ignorance, it was compliance-without-action: at 195k tokens the agent ran the audit I asked for, reported a 77x cache ratio and "bloat HIGH," and continued. The reason it continued was that a "do everything, don't ask" override granted for the previous task had never expired.

The plugin replaces three pieces of advice with mechanism: (1) tool calls are counted and a `<system-reminder>` is stapled onto tool output at the threshold, so the check arrives in the channel the model is already reading rather than depending on it to look; (2) the audit is executed by the plugin and its numbers injected, since "run this and report it" competes with the task in flight and loses; (3) overrides are scoped to the request that granted them, so a new request naming new files revokes the old grant.

A handoff tool is bundled as the escape hatch the reminders point at — it persists the note to disk before switching sessions, which matters because the findings are small and survive a handoff while the tool output that produced them does not.

Design note that generalizes beyond this project: an early version fired the boundary reminder 61 times for a single user message, because the dedupe compared a call count instead of message identity. Repeated injections become wallpaper and the model generalizes to ignoring the whole `system-reminder` channel. Dedupe on message identity.

MIT, targets opencode. https://github.com/salitaba/token-norm

## Submitted PR bodies

Kept verbatim for reference if either PR needs reopening.

### anomalyco/opencode#48182 — `docs: add opencode-token-norm to ecosystem`

Single row appended to the Plugins table in
`packages/web/src/content/docs/ecosystem.mdx`, base branch `dev`:

```
| [opencode-token-norm](https://github.com/salitaba/token-norm)                             | Enforce a token budget with self-firing cost reminders, plus a session handoff tool                |
```

### awesome-opencode/awesome-opencode#693 — `docs: add token-norm to plugins`

New file `data/plugins/token-norm.yaml`, base branch `main`:

```yaml
name: Token Norm
repo: https://github.com/salitaba/token-norm
tagline: Token budget enforcement that fires on its own, plus a session handoff tool
description: >-
  Counts tool calls per session and staples a system-reminder onto tool output
  at the cost-statement threshold and periodically after, so the budget check
  happens even when the agent is deep in a task. It runs the usage audit itself
  and injects the numbers rather than telling the agent to run one. Overrides
  like "do everything" expire with the task that granted them instead of
  silently carrying into the next request. Bundles a handoff tool that writes
  the note to disk, then opens a fresh session with the note pre-filled.
tags:
  - tokens
  - cost
  - context
  - handoff
  - sessions
```
