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

## Post-Phase-2 - continued autonomous run (2026-06-01)

### #13 - frontend test harness + Mission Control coverage - DONE

Stood up a jsdom DOM-testing harness as a SECOND vitest project so the
Preact UI is testable without disturbing the node backend suite:
`vitest.workspace.ts` (defineWorkspace: the existing node config + a `web`
project, jsdom env, `@/` + preact/compat aliases, `web/src/test-setup.ts`).
Added 16 tests (suite now 510 / 35, up from 494 / 32):

- `web/src/pages/missionTasks.test.ts` (9) - extracted pure view-logic
  (`partitionTasks`, `isTerminal`/`TERMINAL`, `statusTone`, `hasMoreHistory`)
  into `web/src/pages/missionTasks.ts` so it is unit-testable with no DOM.
- `web/src/components/Pill.test.tsx` (3) - tone palette + neutral default.
- `web/src/pages/MissionControl.test.tsx` (4) - queue grouping, click-to-open
  detail drawer (fresh server copy), Completed archive + Load-more pager, and
  the reassign honesty contract (server `ok:false` race shows "Task is no
  longer queued.", never a phantom success - locks the no-mock-data rule on
  the live mutation surface).

Bug fixed in passing: completed-task Pills rendered with no color because the
status `completed` had no palette entry (the palette key is `done`). Added a
tested `statusTone()` mapping. Exported `Tone` from Pill.tsx. All committed,
pushed, deployed, verified earlier in the run.

### Web typecheck hole - PARTIALLY closed

Finding: `web/tsconfig.json` is strict (`noUnusedLocals`,
`noUnusedParameters`, `strict`) and `noEmit`, but NOTHING ran it - the
build's `tsc` only covers the backend (`rootDir ./src`). So every frontend
type error has been shipping unchecked. A clean run surfaced 37 errors.

Closed 14 of 37 at the root (commits `6c07180`, `f86c0bd`, `b1be253`):
- Added a runnable `typecheck:web` script (`tsc -p web/tsconfig.json`).
- `web/src/vite-env.d.ts` (`/// <reference types="vite/client" />`) types
  `import.meta.env` - clears 2 errors in BrainGraph3D.
- `web/src/lib/privacy.ts`: `_signals` was typed
  `ReturnType<typeof signal<boolean>>`, which resolves via the signal no-arg
  overload to `Signal<boolean | undefined>` and leaked an optional boolean to
  every consumer (5 errors in HiveMind + Scheduled). Typed it `Signal<boolean>`
  at the source. HiveMind and Scheduled now typecheck clean.
- Dropped genuinely-unused imports (HiveMind `useEffect`; Specialists
  `useEffect` + `apiPost`; Scheduled `Pencil`).
- `AgentSuggestions.tsx`: `act()` now guards a real null-deref (its sibling
  `dismiss()` already asserts non-null; closures don't inherit the line-35
  guard's narrowing). Plus dropped a dead `willRun` compute in StandupConfig
  that the `inCap` check on the next line already supersedes.

Not deployed: type-only / cleanup, runtime is byte-identical (privacy.ts
emit unchanged, unused imports tree-shaken already, the .d.ts is not bundled).

REMAINING 20 errors (17 of 37 now closed after the 2026-06-01 follow-up
cleared BrainGraph3D's last 3; deferred set touches the visual centerpiece or
needs a small design call, so they are left for a session where the user can
weigh in rather than autonomously deleting creative WIP):

| File | Count | What | Why deferred |
|---|---|---|---|
| pages/JarvisHome.tsx | 12 | 10 unused shader consts (PLASMA_VERT, ORB_FRAG, CORE_*, SHELL_*, BACKDROP_*, playBootSweep, makeCurvedHologramPlane) + 2 three.js type mismatches (Float32Array@993, OrbUniforms index sig@1596) | orb visual centerpiece; deleting parked shaders / changing render types is a creative+design judgment |
| pages/Settings.tsx | 6 | 5 unused helper components (Section/Card/Row/Divider/ReadOnlyRow) + CardGroup missing `children`@217 | unused set looks like a parked component kit; CardGroup needs a children decision |
| components/SpecialistFloor.tsx | 1 | `tone="warn"`@157 not in Pill `Tone` union | needs a palette/design call (add a `warn` tone + color token, plus entries in both `Record<Tone>` maps) |
| components/Sidebar.tsx | 1 | unused `open`@22 (from `sidebarOpen`) | `closeSidebar` is still used, so a mobile drawer may be half-wired; left intact rather than rip out possible WIP |

To finish the gate later: clear these 20, then wire `typecheck:web` into the
`build` script (or a pre-push check) so frontend type errors can never ship
unchecked again.

### Reliability follow-ups (2026-06-01) - DONE

Continued the autonomous run with three pure-additive / no-runtime-change
slices (suite now 518 / 36, build green throughout):

- `web/src/lib/useFetch.test.tsx` (commit `7eba81d`): 8 tests via a tiny
  Harness component (no renderHook dep) locking the SWR hook every page
  leans on - cold-start loading flash, ApiError-vs-String error branch,
  null-path no-op, manual refresh, process-local cache hydration on remount,
  stale-clear on path change, and polling. Unique paths per test dodge the
  module-level `_cache` bleed.
- `src/agent.test.ts` fake timers (commit `a551564`): the retry tests slept
  through the real backoff (2s, then 8s + jitter), so the file took ~16s and
  was the source of the occasional full-suite flake (now RESOLVED). Switched
  to `vi.useFakeTimers()` + `vi.runAllTimersAsync()`. Safe because runAgent
  always clears its 4s typing `setInterval` in its `finally` before settling,
  so the pump only drains the retry-loop sleeps and never spins on a live
  interval. File dropped 16s -> 13ms; whole suite 17s -> ~3.5s.
- 4 more web tsc errors closed (commit `44aac9e`): matched the useFetch mock's
  `ApiError` to the real `(status, body, message)` ctor so the call site
  type-checks, and removed three dead locals in BrainGraph3D (unused
  `lobeWeights` x param -> `_x`, unused `radial`, unused map index `i`).
  BrainGraph3D is now tsc-clean.
- Real Telegram send tests made opt-in (commit `46c496f`): `file-send.integration.test.ts`
  gated its real-API sends only on token+chatId presence, but THIS box always
  has a live token in `.env`, so they fired on every `npm test` and sent real
  files to your Telegram chat (HEADS UP: a handful of "Integration test: file
  sending works" / PDF test files landed in the chat during this run before the
  fix). Now require an explicit `RUN_TELEGRAM_INTEGRATION=1` flag; default runs
  skip them (suite reads 514 passed / 4 skipped) and are network-free.
- schedule-cli test store isolated (commit `c6bf5a1`): the routing tests spawn
  the real `dist/schedule-cli.js` as a child process, which resolved its own DB
  independent of the in-process test hooks (the imported `_initTestDatabase`
  was never even called), so every `npm test` wrote scheduled tasks into the
  production `claudeclaw.db` - and an interrupted run could orphan a cron that
  fires daily at 09:00. Added a `CLAUDECLAW_STORE_DIR` override in `config.ts`
  (mirrors `CLAUDECLAW_CONFIG`; every store consumer - db, PID files, logs,
  avatars, waweb - routes through `STORE_DIR`, so it relocates the whole store
  coherently) and pointed the child CLI at a per-test temp dir. Verified the
  override lands the DB in the temp dir and the real `store/claudeclaw.db` is
  untouched, and confirmed no orphan test tasks remain in the real scheduler.
  Documented in `.env.example`. Runtime-additive but behavior-identical when
  unset, so no redeploy. Bonus: operators can relocate the store via env now.

### Coverage expansion (2026-06-01, second slice) - DONE

After the reliability fixes above, kept the autonomous run going by adding
unit tests to previously-uncovered pure-logic / security modules. Picked
targets that are deterministic and safe to test (no live services, no real
side effects) and skipped paths that can't be tested honestly. Suite grew
514 -> 633 passed (4 skipped); build + full `tsc` green throughout; 9 commits,
all pushed. NO deploy: every change is test-only except the oauth-health
extraction, which is behavior-identical and the feature is opt-in/off.

- `src/warroom-tool-policy.test.ts` (commit `a19241f`, 21 tests): the
  security boundary that stops a prompt-injected war-room message from
  driving Chrome / writing files / reaching M365 / Slack. Pins default-deny
  of side-effect tools, always-allow of read-only built-ins, explicit
  allowlist replacing per-agent defaults, and MCP staying unexposed unless an
  `mcp:` override names it.
- `src/security.test.ts` (commit `9515c2b`, 26 tests): `getScrubbedSdkEnv`
  (drops enumerated + pattern-matched secrets and nested Claude-Code vars from
  the subprocess env, preserves/ re-injects the two SDK auth vars), PIN
  hashing + lock state machine incl. legacy bare-hash + idle auto-lock (fake
  timers), kill-phrase matching, audit callback error-swallowing. Added a
  test-only `resetSecurity()` export (initSecurity intentionally never clears a
  live PIN, so without it a PIN leaks across tests). `executeEmergencyKill`
  left uncovered on purpose (process.exit + service-control spawns).
- `src/message-queue.test.ts` (commit `588efc3`, 6 tests): per-chat FIFO
  ordering, cross-chat parallelism, synchronous pending counts, drain cleanup,
  throwing-handler isolation.
- `src/tool-labels.test.ts` + `src/platform.test.ts` + `src/state.test.ts`
  (commit `20fbbe4`, 27 tests): label mapping incl. `mcp__server__tool`
  parsing; platform IS_* flags / venv path / label + handoff builders / PID
  guards (no real kills; signal-0 self-probe + dead-PID check only); state bot
  info + telegram flag + chatEvents bus + processing flag + abort registry incl.
  `abortByPrefix`.
- `src/oauth-health.ts` + `.test.ts` (commit `d2acb0b`, 9 tests): extracted
  the alert-level state machine (none/warning/expired + when to actually
  notify) out of the non-exported `checkOAuthHealth` into a pure
  `decideOAuthAlert(remainingMs, thresholdMs, lastLevel)` and rewired the
  caller to use it (one source of truth). Behavior-identical (same boundaries,
  same one-shot dedup, healthy never alerts); verified by inspection + tsc.
  Feature is opt-in (`OAUTH_HEALTH_ENABLED`), so dormant unless turned on.
- `src/embeddings.test.ts` (commit `7e846d1`, 12 tests): `cosineSimilarity`
  pure math + `embedText`'s bge-m3 NaN-retry logic (mock `ollamaEmbed` at the
  boundary: success passthrough, retry-with-sanitized only on NaN/unsupported,
  no retry on unrelated errors or when sanitizing is a no-op, empty short-circuits).
- `src/warroom-text-router.test.ts` (commit `79dc52c`, 18 tests): the
  `_internal` helpers it exports for tests - `parseJson` (fences/commentary
  tolerance), `sanitizeDecision` (rejects out-of-roster primary, drops
  invalid/dup/primary-equal interveners, caps at 2, bounds reason),
  `routerFallback` determinism, and prompt builders neutralizing `"""`
  delimiters in untrusted user text / roster descriptions / replies.

Remaining untested-but-candidate modules (for a future slice; each needs
either heavier mocking or a judgment call): `agent-config.ts`, `config.ts`
(pure helpers, but reads files at module load), `env-write.ts` (file writes),
`slack.ts` / `whatsapp.ts` / `daily-client.ts` (network clients), the
`*-html.ts` template strings (low value), and `orchestrator.ts` (large,
side-effecting). The web typecheck gate (20 deferred errors above) is still
the other open longevity item.

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
