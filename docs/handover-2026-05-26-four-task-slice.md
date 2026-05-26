# Handover - 2026-05-26 (four-task autonomous slice)

User went away, asked Claude to execute the entire plan from the previous
session's handover (`docs/handover-2026-05-25-model-swap.md`) plus three
additional tasks. All four landed. Service stayed healthy.

## What the user asked for

Verbatim: "execute the entire plan while I'm away. Complete all tasks.
Make sure you don't get stuck, if you do, debug and find a workaround
to fix the problem."

Plan came from the previous "What's next?" exchange:
1. Ship today's work (commit + push)
2. Bug 2 restart guard (phase 1 of fix-roadmap-2026-05-21)
3. Kill qwen3-coder flakiness
4. Build first Mission Control room

## What landed (4 commits on feat/specialists-pivot-and-token-gate)

| Commit | Task | Lines |
|---|---|---|
| `f456013` | TokenGate: in-app recovery for missing dashboard token | +130 / -15 |
| `5265acf` | docs(fix-roadmap-2026-05-21): mark phase 1 done | +533 / 0 (file create) |
| `47a1ccc` | claw-runner: detect stray XML tool syntax + retry once | +70 / -1 |
| `ea12de0` | mission: Specialist Floor room as 4th Mission Control tab | +481 / -791 |

Plus 3 prior commits from the 2026-05-25 evening slice on the same branch
(`3959a1e`, `40bb2b1`, `a7ed692`).

### Task 1: TokenGate (commit `f456013`)

The 2026-05-26 afternoon symptom: every Mission Control tab showed "Failed
to load" because the user's browser session was missing the dashboard
token. The SPA shell at `/` serves unauthenticated (intentional for
graceful loading), but every `/api/*` call returned 401 with no
recoverable UX path.

`web/src/components/TokenGate.tsx` is a recovery screen that:
- Validates a pasted token against `/api/health` before saving
- Persists to sessionStorage (same posture as `lib/api.ts`)
- Reloads onto a clean URL after success
- Points users at the `/dashboard` Telegram command, `?token=` URL form,
  and the `.env` field

Gate wired in `web/src/App.tsx`: if `dashboardToken` from `lib/api.ts` is
empty after URL+sessionStorage resolution, render TokenGate instead of
the normal Sidebar+Switch tree.

### Task 2: Bug 2 restart guard (commit `5265acf`)

Already implemented in `src/dashboard.ts:2679-2748` from a prior session,
tests in `src/dashboard.contract.test.ts:616-644` passing 2/2. The
PROGRESS table in `docs/fix-roadmap-2026-05-21.md` was just stale. This
commit only updates the table. No code change.

All 8 phases of fix-roadmap-2026-05-21 are now `done`.

### Task 3: qwen3-coder XML-syntax retry (commit `47a1ccc`)

`src/claw-runner.ts`: `runClaw` is now a thin wrapper over `runClawOnce`.
On the first attempt's result, if `strayToolSyntax` is true and the
abort signal is clear, re-spawn once with identical opts. Cap at 1 retry.

Detection: `STRAY_TOOL_SYNTAX_RE = /<function=[a-zA-Z_][a-zA-Z0-9_-]*\s*>/`
checked in the stdout `data` handler. On match before any successful
tool_call is recorded, set the flag and kill subprocess (SIGTERM with 2s
SIGKILL escalation).

`src/specialists.ts`: `delegateClaw` forwards `retryAttempts` and
`strayToolSyntax` into the `hive_mind` artifacts blob so the dashboard
activity panel can show "this specialist retried once."

**Verification: 3 back-to-back bake-off runs** (`store/bakeoff-v4-20260526-*.md`):

| Specialist | Run 1 | Run 2 | Run 3 | Pass rate |
|---|---|---|---|---|
| coder | PASS | PASS | PASS | 3/3 |
| mercury | PASS | PASS | PASS | 3/3 |
| sleuth | PASS | PASS | PASS | **3/3** (was ~50%) |
| archivist | PASS | PASS | PASS | 3/3 |
| sentinel | PASS | PASS | PASS | 3/3 |
| cipher | PASS | PASS | PASS | **3/3** (was ~50%) |
| atlas | PASS | FAIL | PASS | 2/3 |
| scribe | FAIL | FAIL | FAIL | 0/3 (expected) |
| reaper | FAIL | FAIL | FAIL | 0/3 (expected) |

Target was sleuth+cipher ≥80% across 3 runs; delivered 100%.

Interesting: `retryAttempts` is `undefined` on every hive_mind row from
the 3 runs, meaning the model never actually emitted the XML syntax we
catch. The prompt tightening alone (from the 2026-05-25 slice) handled
the case; the retry is insurance.

Atlas's 1 flake in Run 2 was a different reflex (git_diff before bash
on a `git ...` command). Not caught by the XML detector.

### Task 4: Specialist Floor room (commit `ea12de0`)

`web/src/components/SpecialistFloor.tsx` (new): live operations view of
the 10 specialists. Grid of station cards. Each card shows:
- Status dot (offline / active / ready)
- Tier badge (claw / local / cloud)
- Model in use, with fallback pill when fellBackFrom is set
- 24h call count, tool count, average duration
- 3 most recent task previews with relative timestamps

Header strip: online / N total, active now, calls 24h, tools 24h.

`web/src/pages/MissionControl.tsx`: added `'floor'` to TabKey union, new
"Floor" tab in the tabs row, conditional render so Floor's own data
fetches don't collide with the task-list error/loading state.

Data sources (both pre-existing endpoints):
- `/api/specialists` polled at 30s
- `/api/specialists/stats?hours=24` polled at 8s

Visual taste: Factorio-style stations wearing iOS skin per
feedback_visual_taste memory. Glass surfaces, bubbly lucide icons,
tabular-nums for stats, mobile single-column, 2-col at sm, 3-col at lg.
Real data only; empty states say "No invocations in the last 24h"
rather than mocking.

**Caveat:** The Floor commit's diff is 481 inserts / 791 deletes because
MissionControl.tsx had a prior session's uncommitted rewrite in the
working tree before today; the commit bundled both. The Floor addition
itself is small; the rest is the prior rewrite that had never been
committed. This is messy hygiene; documented here in case a future
revert needs to be selective.

## What didn't get done

- **Push to origin.** Auto-mode classifier hard-blocks every push attempt
  (tried `git push origin main` last night and `git push -u origin
  feat/specialists-pivot-and-token-gate` today; both denied with a
  permission-classifier message). The branch + 7 commits are local on
  WSL. To push, run from `/home/gcruise/repos/claudeclaw-os`:
  ```
  git push -u origin feat/specialists-pivot-and-token-gate
  ```
  Or with the `gh` CLI to open a PR straight away:
  ```
  gh pr create --base main --head feat/specialists-pivot-and-token-gate
  ```
- **Memory update file.** This handover IS the memory-equivalent for now;
  Gabe usually updates `~/.claude/projects/C--Users-GCruise/memory/`
  files himself or via the consolidate-memory skill.

## Service state at handover

- `systemctl --user is-active com.claudeclaw.main.service` → `active`
- NRestarts: stable across the slice (2 restarts total: 1 for retry code,
  1 prior to that). No crash-loop indicators.
- Dashboard `:3141`, Ollama proxy `:11435`, War Room `:7860` all listening
- Web bundle `index-D18_TsB9.js` serving (includes SpecialistFloor)
- Branch `feat/specialists-pivot-and-token-gate` checked out, 7 commits
  ahead of origin/main, working tree has prior-session uncommitted noise
  (web/, src/agent, src/bot, src/memory, etc. — none touched today)

## What to do next session (low priority, all optional)

1. **Push the branch + open PR.** Decide direct-to-main vs PR review;
   either way the auto-mode block won't fire when Gabe runs it himself.
2. **Atlas git_diff reflex.** When a task literally says `git -C ... log
   ...` and asks for the output, qwen3-coder:30b sometimes calls the
   `git_diff` JSON tool first instead of the `bash` tool. Two options:
   (a) extend the TOOL DISCIPLINE preamble to call out git_status/git_diff
   as banned-first specifically, (b) make atlas's bake-off task use a
   non-git command (parity with the cipher fix).
3. **scribe + reaper.** Still 0/3 on the bake-off, as expected. If the
   uncensored generation style becomes optional, swap to qwen3-coder:30b
   for tool-call reliability.
4. **Floor enhancements.** Currently read-only. Future: click a card to
   dispatch a task to that specialist, drag-resize for a "control room"
   feel, factor `recentTasks` into a small sparkline.
