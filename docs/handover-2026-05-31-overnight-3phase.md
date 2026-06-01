# Handover - 2026-05-31 (overnight 3-phase autonomous run)

Living progress doc for the approved ~8h overnight run. Updated at each
phase checkpoint so the next session bootstraps from truth. Working on
branch `main`. UPDATE 2026-05-31 late: the user granted full autonomous
authority for the night and explicitly required that all work be "pushed
implimented, and implimented correctly without breaking anything else."
So push AND deploy are now authorized and being done in verified
increments (was previously hold-and-ask).

## The plan (user-approved: "Full 3-phase, recommended")

- **Phase 0** - finish + commit the ~90%-done prior-session in-flight
  work, green the build (`npm run build` = vite + tsc) and tests
  (`npm test` = vitest). Commit in logical chunks; atlas change as its
  own small commit. Do NOT push.
- **Phase 1** - specialist reliability hardening.
- **Phase 2** - Mission Control completion.

## Phase 0 - DONE

Build GREEN (vite + tsc), full suite GREEN (475 tests / 30 files). The
~3.1k-line prior-session in-flight blob is committed as 8 logical
commits on local `main` (ahead of origin by 8, unpushed):

| Commit | Scope |
|---|---|
| feat(memory) | compact byte-budgeted context + pinned-core block; bge-m3 NaN sanitize |
| feat(agent) | intelligentRoute before main query; route on clean message |
| feat(dashboard) | tool_use/tool_result SSE, specialist stats, graceful /api/chat/history |
| feat(web) | JarvisHome boot sequence, tool cards, UI polish, gsap dep |
| feat(bot+voice) | polymorphic /pin, clean-message routing, JARVIS voice tuning |
| chore(infra) | ollama prefix proxy wiring, qwen3 think:false, .gitignore hygiene |
| fix(atlas) | TOOL DISCIPLINE prompt + workspace-write (the separate small commit) |
| docs | 2026-05-24 handover |

Test fixes this session (the ~23 stale-mock failures): memory.test.ts
(new compact format + getConsolidationsWithEmbeddings shape),
memory-consolidate.test.ts (mock the Agent SDK `query` boundary, not the
old gemini path), agent.test.ts (config mock missing agentSystemPrompt),
dashboard.contract.test.ts (history now 200-with-default, not 400).

.gitignore now covers: `.claw/`, `.sandbox-home/`, `.sandbox-tmp/`
(claw runtime sandboxes), `/scripts/.*` (dot-prefixed scratch), and the
machine-specific boot wrappers (`scripts/wsl-boot.sh`,
`scripts/claudeclaw-startup.vbs` - hardcoded user/distro/paths, left
untracked like `win/`).

## Phase 1 - specialist reliability hardening - DONE

Tasks #4-#8 complete. Build GREEN (vite + tsc), full suite GREEN (494
tests / 32 files, up from 475; +19 new). Grounded in the atlas handover
finding: residual flake is a qwen3-coder:30b over-exploration /
fabrication ceiling, and `--allowedTools` BACKFIRES on this model+claw
version (stray XML) - do NOT retry that lever.

What landed:

1. (#4) Wall-clock timeout in `runClawOnce` (src/claw-runner.ts).
   `ClawRunOptions.timeoutMs` (default `DEFAULT_CLAW_TIMEOUT_MS` = 240s),
   SIGTERM then SIGKILL after a 2s grace, resolves with `timedOut: true`.
   A wedged local model can no longer pin the GPU / stall a turn forever.
2. (#5) Broadened the single retry in `runClaw` beyond stray-XML.
   `isRetryableFailure` now also retries on `timedOut` and on a total
   no-op (no text, 0 tool calls, no error). Aborts and deterministic
   errors (binary missing, model-emitted error, non-zero exit) are NOT
   retried and surface as-is.
3. (#6) Labeled (not hidden) the silent no-tools fallback at
   `delegateClaw`. When claw errors and the direct-ollama fallback
   answers, the output is prefixed with `NO_TOOLS_FALLBACK_NOTICE` and
   the hive_mind row is tagged `unverified: true`.
4. (#7) Anti-fabrication critic: new opt-in `expectsToolUse` flag on
   `SpecialistConfig`, set on the four documented fabricators (sleuth,
   archivist, sentinel, cipher). When such a specialist returns with
   `toolCalls === 0`, the output is prefixed with `UNGROUNDED_NOTICE` and
   the hive_mind row carries `ungrounded: true`. Prose / vision /
   pure-reasoning roles leave it unset, so a tool-less answer there stays
   unlabeled. Both notices are plain ASCII (no em/en dashes) since they
   surface verbatim to the user and to Jarvis.
5. (#8) First unit tests: `src/claw-runner.test.ts` (11 tests - argv
   assembly for analog + full claw, NDJSON parse, stray-XML / empty /
   timeout retry, abort + deterministic-error no-retry; mocks the
   child_process + fs boundary) and `src/specialists.test.ts` (8 tests -
   ungrounded + no-tools-fallback labeling, no false positives on prose
   or tool-using runs, plus resolveSpecialistModel chain).

Committed in logical chunks on local `main` (still unpushed). Not
deployed (see deploy note).

## Phase 2 - Mission Control completion - DONE

Build GREEN (vite + tsc), full suite GREEN (still 494 tests / 32 files;
this slice is frontend-only, no new unit tests). One commit on local
`main` (unpushed): `feat(web): Mission Control task drill-in, reassign,
history archive`.

IMPORTANT: the original 5-item list below was written from a stale plan.
Verifying against the actual files (MissionControl.tsx is 529 lines, not
the 1085 an Explore agent fabricated) showed most of it was already
built (4-tab Queue/Active/Completed/Floor UI, SpecialistFloor, create
modal, auto-route, cancel, delete). All backend endpoints already exist
in `src/dashboard.ts` (1635-1743) and `src/db.ts` (2288-2392), verified
by reading them. The real, remaining gaps were narrower:

What landed:

1. Mounted the dead `TaskDetailsModal` as a click-to-open drill-in (click
   a task title). It pulls a fresh copy via `GET /api/mission/tasks/:id`
   so a running task shows its latest result, and shows status / prompt /
   result / error / created+started+finished timing. Replaces the old
   inline row expand with one richer detail surface.
2. Reassign via `PATCH /api/mission/tasks/:id`, queued-only (matches the
   backend `reassignMissionTask` `WHERE status='queued'` constraint). The
   handler checks the returned `ok` flag, so a task that just raced into
   `running` is reported honestly ("Task is no longer queued.") instead
   of a false success. This consumed the previously dead `apiPatch`
   import and the dead `agents` prop.
3. Completed tab is now a true archive backed by `GET /api/mission/history`
   (`{ tasks, total }`) with a real total badge and a "Load more" pager
   (30/page), replacing the old client-side cap of 50 off the live poll.
   Also excluded terminal tasks from the Queue group and removed the
   unused `StatusDot` import.

Deliberately NOT done (these two stale items contradict current design):

- "Floor card drill-in" - SpecialistFloor.tsx (line 241) intentionally
  defers per-specialist history to the `/specialists` page; the Floor is
  the live-ops grid. Building a drill-in here would fight that decision.
- "Priority queue view" - the create modal (CreateTaskModal comment)
  explicitly abandons priority: every task routes to Jarvis (main) who
  picks the specialist via intelligentRoute. A priority UI would
  contradict that product decision.

UI note: changes are verified by tsc + the full test suite + matching the
independently-read backend contracts. They were NOT browser-verified: the
dashboard needs a live backend, an auth token, and seeded mission data,
and the running service is the old build (deploy is gated, see below).

## Guardrails in force

Push + service-deploy now AUTHORIZED (see intro). Still NO PC restart /
plugin install / permission-OAuth / `.env` / Jarvis-persona edits without
explicit approval (a `systemctl --user restart` of the app is NOT a PC
restart and is allowed). No mock data. No em/en dashes. Intelligence >
cost (Max plan; cloud Claude is default for main Jarvis, local for
specialists per the 2026-05-25 pivot).

## Deploy note

DONE 2026-05-31 23:41. Restarted `com.claudeclaw.main.service`; came back
active/running (new PID, 0 restarts), clean boot logs ("Database ready",
"Dashboard server running" :3141, "ClaudeClaw online: @GCruiseJarvisBot").
Token-gated `GET /api/health` returns HTTP 200 with model
`claude-opus-4-7`, `telegramConnected: true`, no kill-switch refusals. All
of Phases 0-2 are now live. Origin/main at the deployed HEAD (0 ahead).
Next deploys this session follow the same gate: build + full vitest green,
commit, push, restart, verify health 200 + clean logs.
