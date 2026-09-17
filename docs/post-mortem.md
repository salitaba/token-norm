# My agent audited itself, reported 3.0M tokens of waste, and kept going

*Draft long-form post. Voice: first person, author handle @salitaba. Publish as the long-form companion to `docs/promo.md` (short-form launch copy) and the screencast in `docs/screencast-script.md`. No real dollar figures or dates exist for the original session. Keep it that way.*

At 195k tokens deep, my coding agent did exactly what I asked. It ran the usage audit, read the numbers, and reported them: 77x cache ratio, bloat HIGH.

Then it kept working for another 90k tokens.

## The setup

I keep a token-discipline norm loaded into every session. Size the task before starting. State the expected cost. Split at phase boundaries. Run the usage audit on long jobs. It sits in the context window from the first message, and on paper it is exactly the discipline you want an agent to have.

The session that broke my faith in prose was 184 tool calls and 3.0M effective tokens. The norm was in context the entire time. The agent was not ignorant of it.

Here is what actually happened.

**Failure 1: presence is not enforcement.** Instructions compete with the task in flight, and the task always wins. The task is what the user asked for ten seconds ago; the norm is what the user asked for weeks ago. Having the rule in context changes nothing about which one the model acts on when they conflict.

**Failure 2: reporting a number is not acting on one.** When "size the task" failed, I doubled down and added "run the usage audit at checkpoints." The agent complied. It executed the audit, surfaced a 77x cache ratio and bloat HIGH, and then continued as if it had read someone else's medical chart. Compliance without action looks like success in a transcript and costs the same as silence.

**Failure 3: overrides leak.** The real reason it continued was worse than laziness. I had said "do everything, don't ask" for the previous task. The grant silently carried into the next request. Nothing revoked it, because nothing was designed to. A blank cheque you wrote an hour ago should not fund the next three tasks.

## What prose can't do

So I wrote `opencode-token-norm`, a plugin that replaces the three failing pieces of advice with mechanism:

- **It counts tool calls and interrupts.** At 25 calls, a `<system-reminder>` is stapled directly onto tool output, the channel the model is already reading. It cannot miss the reminder, because it arrives attached to the output it is about to process. Bookkeeping tools (todo, question, skill) are exempt, so planning does not trip the alarm.
- **It runs the audit itself.** Every 60 calls, the plugin executes the bundled `usage-audit.py` read-only against the session database and injects the real numbers. No "agent, please go look."
- **Overrides expire with the task.** A new user message past 40 calls marks a task boundary. A "do everything" grant is scoped to the request that granted it. This is the piece I have not seen anywhere else, and it is the one that would have saved that session.
- **Handoff is the escape hatch.** One tool call writes a structured note to disk, opens a fresh session, and pre-fills the prompt. The findings are small and survive a handoff; the 80k of tool output that produced them does not.

## The bug that taught the real lesson

The first version of the boundary reminder fired 61 times for a single user message. The dedupe compared a call count instead of message identity.

That is worth more than a changelog entry. Repeated reminders become wallpaper, and worse: the model generalizes and starts skipping every system-reminder, not just the noisy one. If you inject anything into an agent's context, dedupe on message identity, not on a counter.

## Try it

`npm i opencode-token-norm`, add it to the `plugin` array in `opencode.json`, restart. MIT. Requires Node 22+; the audit needs `python3`.

https://github.com/salitaba/token-norm

---

*If you have hit the stale-override problem, "do everything" leaking across task boundaries, I would like to know how you scoped it. It feels like it should bite every agent harness, not just opencode.*
