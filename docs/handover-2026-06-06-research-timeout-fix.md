# Handover - 2026-06-06 (fix: research run timed out)

The first real project research run (Section 224) hit the 10-minute mission cap and
the library entry showed "failed: Research run timed out after 10 minutes." Gabe:
"fix this so it never happens again." Root cause + fix below.

## Root cause

The dual-track research run is a chain of model calls (sleuth + oracle, then prism +
heretic, then synthesis). Two things made it blow past 10 minutes:
1. **oracle ran on the claw tier** (local abliterated model through the claw-code
   tool loop). Abliterated models rarely emit tool_calls and the loop is slow and
   spin-prone, so oracle alone ate most of the budget.
2. **The mission cap is 10 minutes**, tuned for quick missions, not a heavy local
   dual-track.
3. The recipe **auto-escalated HIGH-risk flags to reaper** (the 35b, which spills to
   CPU on the 16GB GPU and is very slow), a worst-case slow leg on the default path.

## Fix (three parts, so it cannot recur)

1. **oracle: claw -> local tier** (`src/specialists.ts`). It now reasons over the
   injected Brave `[SEARCH RESULTS]` in a single bounded inference (same path as
   heretic), instead of driving the claw tool loop. Fast and reliable; keeps the
   uncensored value (same sources sleuth gets, no guardrails). Dropped
   clawPermission/clawUseFull; union comment + persona roster updated;
   specialists.test.ts asserts tier 'local'. Verified live: `/api/specialists`
   shows oracle local / gemma-4-abliterated / available.
2. **Separate, longer research ceiling** (`src/scheduler.ts`). New
   `RESEARCH_TASK_TIMEOUT_MS = 25 min`, used when `mission.project_id` is set;
   normal missions keep the 10-min `TASK_TIMEOUT_MS`. Timeout failure messages now
   report the actual minute count instead of a hardcoded "10 minutes".
3. **reaper escalation softened** (`src/dashboard.ts` research prompt + persona
   recipe). reaper is no longer fired by default; only a HIGH-risk discrepancy that
   would materially change the conclusion may escalate that single point. Most runs
   skip it and stay fast.

Net effect: a typical run is now sleuth (cloud, fast) + oracle (local, ~1-2 min)
in parallel, then prism (cloud) + heretic (local 8b) in parallel, then Jarvis
synthesis. A few minutes, well under the 25-min net. reaper only on rare explicit
escalation.

## Build + deploy + verify

Typecheck + build + full suite GREEN (73 files, 1022 passed / 4 skipped). Deployed
via busy-guarded restart; oracle confirmed local + available. The failed Section 224
item was deleted and the research re-run (item 2c59beb4) was triggered to verify the
chain completes end to end (monitored separately).

## Known trade-off (not fixed here, noted)

A research run still executes as a main-agent mission on the user's chat queue, so
while it runs (now a few minutes) it occupies that queue. Making oracle local cut
this from ~10+ min to a few; a fuller fix (run research off the interactive chat
queue) is a possible follow-up if it ever feels blocking.
