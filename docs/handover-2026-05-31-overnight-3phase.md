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
dashboard needs a live backend, an auth token, and seeded mission data. (At
the time of writing the running service was the old build; it has since been
rebuilt and deployed - see Deploy note.)

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

REMAINING 13 errors (24 of 37 now closed; 37 - 13 = 24). Since the original
inventory: the 2026-06-01 follow-up cleared BrainGraph3D's last errors, and
Batch C (below) closed Settings.tsx's 6 (childless CardGroup + 5 dead layout
primitives, commit `73e5977`) and SpecialistFloor.tsx's 1 (the missing Pill
`warn` tone, commit `2c471a3`). A fresh `tsc -p web/tsconfig.json --noEmit` on
2026-06-01 confirms exactly the two rows below remain. The deferred set touches
the visual centerpiece or needs a small design call, so it is left for a
session where the user can weigh in rather than autonomously deleting creative
WIP:

| File | Count | What | Why deferred |
|---|---|---|---|
| pages/JarvisHome.tsx | 12 | 10 unused shader consts (PLASMA_VERT, ORB_FRAG, CORE_*, SHELL_*, BACKDROP_*, playBootSweep, makeCurvedHologramPlane) + 2 three.js type mismatches (Float32Array@993, OrbUniforms index sig@1596) | orb visual centerpiece; deleting parked shaders / changing render types is a creative+design judgment |
| components/Sidebar.tsx | 1 | unused `open`@22 (from `sidebarOpen`) | `closeSidebar` is still used, so a mobile drawer may be half-wired; left intact rather than rip out possible WIP |

To finish the gate later: clear these 13, then wire `typecheck:web` into the
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

Remaining untested-but-candidate modules: see the third slice below, which
cleared `agent-config` / `config` / `env-write` / `orchestrator` and the
`ollama-prefix-proxy` + `dashboard` primitives, and assessed-and-skipped the
thin network clients (`slack` / `whatsapp` / `daily-client`). Still open: the
big `*-html.ts` template strings (low value), `meet-cli.ts` / `index.ts` (CLI /
boot entry, side-effecting), and the web typecheck gate (20 deferred errors
above) as the other longevity item.

### Coverage expansion (2026-06-01, third slice) - DONE

Two more coverage batches. Every change is test-only or an
export-only/behaviour-preserving source tweak; full `tsc` + vitest green
throughout; all pushed. Suite grew 633 -> 730 passed (4 skipped, 54 files).

Batch A (6 commits, 633 -> 687) - previously-uncovered pure helpers:
- `src/env-write.test.ts` (10): atomicEnvWrite + setEnvKey vs a /tmp dir -
  0o600 perms, full overwrite, no .tmp leftover, in-place first-occurrence key
  replace preserving order/comments, prefix-collision safety, round-trip.
- `src/agent-config.test.ts` (9): AGENT_ID_RE path-traversal guard (accepts
  valid incl. uppercase; rejects '', '..', '../etc/passwd', slashes, abs,
  dots/spaces); agentExists pre-fs reject; resolveAgentDir fallback shape.
- `src/orchestrator.test.ts` (14): parseDelegation for `/delegate <id> <prompt>`
  and `@id: <prompt>` (case-insensitivity, lazy colon capture, hyphen ids,
  empty-registry guard against bare `@id` false positives, incomplete -> null).
- `src/agent-create.test.ts` (10): validateAgentId VALID_ID_RE (lowercase,
  leading-letter, max 30, reserved 'main'); suggestBotNames; pickAgentColor
  palette + modulo wrap. (Flagged validateAgentId's dead leading-underscore
  check via spawn_task for the user to prune.)
- `src/config.test.ts` (7): expandHome (~ / ~/sub / bare ~ / ~/ keeps trailing
  slash / leaves abs+rel+~foo untouched); setAgentOverrides +
  updateAgentSystemPrompt pushing into the live ESM bindings.
- `src/ollama.ts` + `.test.ts` (4): extracted the pure `buildOllamaUrlFromHost`
  (full-URL verbatim, strip one trailing slash, host:port gets http scheme,
  bare host gets fallback port) out of resolveOllamaBaseUrl and rewired it (one
  source of truth). Behavior-identical.

Batch B (5 commits, 687 -> 747) - security/reliability primitives:
- `src/warroom-text-picker-html.ts` + `.test.ts` (commit `71ac15a`, 7 tests):
  hardened the inline-`<script>` embedding. getWarRoomPickerHtml put token /
  chatId into a `<script>` block via JSON.stringify alone, which leaves
  `<` `>` `&` intact so a value containing `</script>` could break out. Added a
  `jsLiteral()` helper escaping those three as < / > / & (decoded
  value identical at parse time, source inert) and rewired jsToken / jsChatId.
  Tests pin both sinks: the escapeHtml Back-link href and the jsLiteral script
  constants. THIS is the one served-code change of the segment - see Deploy
  note (functional impact is nil for real tokens; only triggers on HTML-metachar
  input that operator tokens never contain).
- `src/ollama-prefix-proxy.ts` + `.test.ts` (commit `ac0cf84`, 28 tests):
  exported and pinned the five pure helpers that make local Qwen3 specialists
  usable - stripRoutingPrefix (drops openai/xai/grok/qwen/kimi prefixes,
  preserves unknown like huihui_ai/), isQwen3Family, stripThinkingTags (closed +
  unclosed `<think>` blocks), and the cross-fragment streaming state machine
  stripFromContent + processSseLine (drops `<think>` content split across SSE
  chunks for both OpenAI-compat delta and Ollama-native message shapes).
  Export-only, behavior-identical.
- `src/dashboard.ts` + `.test.ts` (commit `bfd74fd`, 8 tests): exported and
  pinned the auth/input guards - safeTokenEqual (constant-time compare, audit
  A4E-1, incl. the null/empty + length-mismatch short-circuits that keep
  timingSafeEqual from throwing) and the WARROOM_TEXT_ID_RE / CLIENT_MSG_ID_RE
  validators (accept the documented shapes; reject wrong prefix/version/variant,
  traversal attempts, illegal chars). Export-only; contract tests still cover
  auth over HTTP, these pin the primitives.
- `src/dashboard-html.ts` + `.test.ts` (commit `5515c8f`, 8 tests): same
  inline-`<script>` hardening as the warroom picker, found during a
  consistency audit of the HTML generators. getDashboardHtml reflected the
  unvalidated `?chatId=` query param into a `<script>` (bare JSON.stringify)
  AND, when the War Room is enabled, raw into a navigation onclick attribute.
  Added a module-level `jsLiteral()` (escapes `<` `>` `&`) for TOKEN / CHAT_ID,
  and rebuilt the War Room link from the safe runtime constants with
  encodeURIComponent so no tainted data is reflected into the attribute at all
  (also fixes a latent bug where an unencoded `&` / space in the token would
  have corrupted the URL). The legacy page is off by default
  (`DASHBOARD_LEGACY`) and token-gated, so practical severity is low; this is
  the SECOND served-code change of the slice - see Deploy note.
- `src/warroom-html.ts` + `src/warroom-text-html.ts` + tests (commit `85afded`,
  9 tests): completed the HTML-generator consistency audit. Both War Room pages
  had the same bare-`JSON.stringify`-into-`<script>` pattern for TOKEN /
  CHAT_ID (and MEETING_ID on the text page); their HTML-attribute reflections
  were already escapeHtml'd. Added a local `jsLiteral()` to each and routed the
  script constants through it. All four generators (picker, dashboard-html,
  warroom voice, warroom text) now share the dual-guard pattern: escapeHtml for
  attribute contexts, jsLiteral for `<script>` constants. THIRD served-code
  change - see Deploy note + the consolidation follow-up there.

Assessed-and-skipped this slice (poor extraction-to-value ratio - the
meaningful behavior IS the I/O): `daily-client.ts`, `slack.ts`, `whatsapp.ts`
(thin network / SDK wrappers with only trivial inline pure bits).

Batch C (2 commits, web typecheck cleanup, 747 -> 748 tests) - deployed with
Batch B's hardening in the 02:16 restart (see Deploy note):
- `web/src/components/Pill.tsx` + `Pill.test.tsx` (commit `2c471a3`): added the
  missing `warn` tone. SpecialistFloor renders `<Pill tone="warn">` for a
  specialist that fell back from another model, but `warn` was absent from the
  `Tone` union, `TONE_STYLE`, and `StatusDot`'s colorMap - both a tsc error
  (TS2322) AND a runtime bug (`TONE_STYLE['warn']` was undefined, so the
  fallback pill rendered with no palette class). Mapped to the amber
  `--color-priority-medium` token; pinned with a test.
- `web/src/pages/Settings.tsx` (commit `73e5977`): cleared the remaining safe
  Settings tsc errors. (1) SpecialistRoutingGroup's error branch rendered a
  childless `<CardGroup/>` (TS2322 + an empty bordered box at runtime) - gave it
  a body row mirroring the sibling loading state, matching the established
  "every CardGroup has children" convention (it is the only childless call in
  the codebase) rather than weakening the shared component's required-children
  contract. (2) Removed five unused, unexported layout primitives (Section /
  Card / Row / Divider / ReadOnlyRow), compiler-confirmed dead (TS6133),
  superseded by the CardGroup / CardRow iOS components the page now uses.

Web tsc errors: 19 -> 13. The remaining 13 stay DEFERRED: 12 in JarvisHome.tsx
(WIP Three.js orb - 10 unused shader consts/fns + 2 Float32Array / OrbUniforms
type mismatches; unverifiable overnight + visual-taste guardrail) and 1 in
Sidebar.tsx (`open` / `sidebarOpen` are vestiges of a mobile slide-in drawer;
the component now uses `hidden md:flex` per a bottom-tab-bar comment - removing
vs. re-wiring is an unresolved mobile-UX product call, not a blind overnight
edit). Wiring `typecheck:web` into the build / pre-push gate stays blocked on
these 13.

### Coverage expansion (2026-06-01, fourth slice) - DONE

Closed the last real gap in the inline-`<script>` security suite. The four
served HTML generators each interpolate caller-controlled token / chatId /
meetingId into a `<script>` block via `jsLiteral` (which escapes `< > &` so a
`</script>` payload can't break out). Re-audited all four test files for that
contract:
- `dashboard-html` / `warroom-html` / `warroom-text-html`: each already had an
  explicit `</script>` breakout test asserting the `</script>` form
  appears and the raw closer does not - their jsLiteral contract is pinned.
- `warroom-text-picker-html`: had NO breakout test. Its script-constant tests
  only asserted `JSON.stringify`-equivalent output using metacharacter-free
  inputs, so a regression downgrading the picker's `jsLiteral(token)` back to
  bare `JSON.stringify` (which leaves `<` `>` `&` intact) would have passed
  every test in the file while silently reopening the breakout.

Fix (commit `2e8f88c`, test-only, suite 748 -> 750): added a local `jsLiteral`
mirror + `</script>` breakout tests for both the TOKEN and CHAT_ID constants in
`warroom-text-picker-html.test.ts`, matching the contract the sibling files
already pin. Verified the picker source does emit jsLiteral-escaped constants
(lines 300-301 from `jsLiteral(token)` / `jsLiteral(chatId)`), so the new
assertions exercise the real escaping path. No source / runtime change, no
deploy. Deliberately did NOT add redundant breakout tests to the other three
(their existing breakout test already covers the shared jsLiteral function) -
that would be test-count padding, not coverage.

With this, the inline-`<script>` injection surface is fully and
non-redundantly covered across all four generators. Also reconciled the stale
"Web typecheck hole" REMAINING table above (it still listed Settings.tsx +
SpecialistFloor.tsx as deferred though Batch C had closed them) to the true 13.

### Coverage expansion (2026-06-01, fifth slice) - DONE

Sustained web-frontend pure-logic test-coverage push across `web/src/lib`.
All test-only: no source / runtime change, nothing to deploy (SPA test files
aren't shipped, and the live bundle was untouched). Suite 750 -> 864 passed
(4 skipped throughout, 68 test files); web tsc held at exactly 13 errors the
whole time (the parked JarvisHome orb + Sidebar items, unchanged). Every new
file passed on first run, confirming the source traces. 11 new files:

- `cron.test.ts` (`b74e7cd`, 31): parseSchedule / buildSchedule / describeCron
  for the visual schedule picker - 12/24h formatting, weekday/weekend/custom
  dow, every-N-min/hour, day-of-month + month branches, raw-cron fallback for
  multi-minute x multi-hour grids, dow=7->Sunday, and a parse->build round-trip.
- `format.test.ts` (`36ba8ae`, 19): formatRelativeTime (fake-timer buckets +
  future-clamp), formatDuration, formatNumber quirks (1999->"2k", 999999->
  "1000k"), formatCost (<$0.01 floor), safeJsonArray.
- `markdown.test.ts` (`68552b6`, 7): renderMarkdown XSS contract - script
  strip (text survives), images dropped, javascript: neutralized, event-handler
  attrs removed, safe https href kept.
- `command-palette.test.ts` (`8c9ce89`, 7): filterActions token/initials match,
  empty-query same-reference, case-insensitivity, no-mutation (synthetic
  actions, decoupled from ROUTES).
- `personalization.test.ts` (`93a25b8`, 15): setWorkspaceName sanitize/cap/
  default, mission-width [240,640] clamp + round (merge vs replace),
  toggleSectionCollapsed immutability, matchesModKey/modKeyLabel explicit modes
  (./api stubbed, fake timers kill the 600ms debounce; 'auto' platform branch
  left untested on purpose).
- `privacy.test.ts` (`12b1ded`, 7): screenshot-blur persistence - default
  unblurred only when unset, new key wins over legacy blurred/revealed, per-
  section memoized signal, toggle flips + persists on/off (reset-module +
  seeded localStorage per case).
- `toasts.test.ts` (`12b1ded`, 8): default 4s duration + caller override,
  durationMs:0 persists, auto-dismiss exactly at the duration, unique ids,
  dismiss-only-the-match (fake timers).
- `theme.test.ts` (`ead9adf`, 7): load* initializers reject malformed/out-of-
  range stored values (defaults ios-dark / accent null / scale 1.0 / costs OFF
  / boot-audio ON) and setters guard input (accent #rrggbb, scale [0.8,1.6]).
- `routes.test.ts` (`ead9adf`, 5): ROUTES invariants - unique paths + shortcuts,
  every section has a SECTION_LABEL, DEFAULT_ROUTE resolves, rooted paths /
  non-empty labels (guards the hand-edited sidebar/palette/router source of truth).
- `api.test.ts` (`d8bd929`, 5): token-append (withToken via tokenizedSseUrl) -
  ? vs & separator, encodeURIComponent, sessionStorage token cache, ApiError
  shape (reset-module + seeded sessionStorage).
- `useDebounce.test.tsx` (`d8bd929`, 3): useDebouncedValue initial value,
  propagate-after-delay, timer-reset on rapid change so an intermediate value
  never lands (fake timers + act()).

Techniques reused: reset-module + seeded localStorage/sessionStorage to drive
module-load initializers through each branch; fake timers for debounce /
auto-dismiss / hook delay; `act()` to flush the preact hook re-render.

Deliberately left uncovered in `web/src/lib` (poor unit-test value, not gaps):
`chat-stream.ts` (heavy EventSource / window / history side effects, no pure
seam), `sidebar.ts` (a one-line setter), `webgl.ts` (needs a real WebGL
context jsdom lacks). In `web/src/pages` the only pure helper is
`missionTasks.ts`, already covered; everything else there + in `components` is
a `.tsx` component (render-harness territory, mostly thin useFetch wiring that
`useFetch.test.tsx` already exercises). The web pure-logic surface is now
broadly pinned; further web gains would be component render tests (higher
fragility, lower value) rather than more lib coverage.

### Coverage expansion (2026-06-01, sixth slice) - DONE

Pivoted from web to the backend Telegram boundary. `formatForTelegram`
(`src/bot.ts`, exported) is the markdown-to-Telegram-HTML converter run on
every Claude response sent to Telegram, but `bot.test.ts` only covered
`splitMessage` + `extractFileMarkers`. It renders with parse_mode=HTML, so
it is the security-critical escaping seam for model output. Test-only,
no source change, nothing to deploy.

- `bot.test.ts` (`2a720f5`, +18 -> file now 46 tests): pins the &-first escape
  order (the only order that doesn't double-escape its own &lt;/&gt;), fenced
  code-block + inline-code protection (contents must NOT be re-interpreted as
  markdown: `**not bold**` inside a fence stays literal), language-tag strip +
  trim, heading->`<b>`, hr removal, checked/unchecked checkboxes, bold/italic/
  strike, snake_case left untouched (`(?<!\w)_..._(?!\w)`), links restricted to
  http(s) so a `javascript:` URL never becomes an anchor (security), and 3+
  blank-line collapse. Tested through the public export (zero source change),
  the codebase-preferred pattern.

Suite 864 -> 882 passed (4 skipped, 68 files); web tsc unchanged at 13.

KNOWN BEHAVIOR (NOT fixed here - served code, behavior change, wants an
eyes-on session not a blind overnight deploy; QUEUED as a spawn_task chip
for Gabe): `formatForTelegram` step 3 re-escapes inline-code content that
step 2 already escaped, so inline code literally containing `<`, `>`, or `&`
double-escapes. e.g. `` `a<b` `` emits `<code>a&amp;lt;b</code>`, which
Telegram then displays as the literal text `a&lt;b` instead of `a<b`. Fenced
blocks are fine (escaped once, in step 1). For a coding bot this is NOT rare
(`Array<T>`, `a < b`, `foo && bar`, `<div>` all trip it), so it is worth
fixing. The new tests deliberately avoid special chars in inline code so they
pin CURRENT behavior; the queued task updates them to assert the corrected
output. Fix = drop the re-escape in step 3 since step 2 already ran (verified
not to weaken XSS protection: step 2 escapes the whole string before step 3
extracts spans, so the captured content can't contain a raw angle bracket).

### Coverage expansion (2026-06-01, seventh slice) - DONE

Extended the HTTP API contract suite. `dashboard.contract.test.ts` exists to
fail CI when the backend drifts from the shape the web rewrite consumes, but
~40 of 63 GET routes were unpinned. Added shape + status-code contracts for
the SPA-depended, DB/config-only read endpoints. Test-only, no source change,
nothing to deploy.

- `dashboard.contract.test.ts` (`d2e2851`, +16 -> file now 81 tests):
  `/api/mission/tasks/:id` (404 + the create->read `{task}` round-trip),
  `/api/memories/pinned`, `/api/agents/:id/{tasks,tokens,status}`,
  `/api/agents/{suggestions,templates,validate-id}` (validate-id pins the
  `{ok:false,error}` reserved-name branch and the `{ok:true, suggestions:
  {displayName,username}}` happy path), `/api/specialists/stats` (the
  [1,168] hours clamp), `/api/specialists/:callsign/history` (unknown ->
  400), and `/api/warroom/{meetings, meeting/:id/transcript, text/list}`.

Deliberately excluded so the suite stays hermetic against the in-memory test
DB: `/api/agents/:id/details` (spawns `systemctl show`), `/api/specialists`
(awaits Ollama model resolution), all SSE streams (`/api/chat/stream`,
`/api/warroom/text/stream`), and Ollama/web-search/Daily endpoints (network).

Suite 882 -> 898 passed (4 skipped, 68 files); web tsc unchanged at 13;
backend `npm run build` green. With this, the backend test surface is broadly
exhausted for low-risk targets: every src file has a test, security-critical
files (exfiltration-guard, warroom-tool-policy, security) are fully covered,
and the remaining uncovered code is async-network clients (slack/whatsapp/
daily) + CLI entry points, where a unit test would be a fragile mock with
little signal.

### Coverage expansion (2026-06-01, eighth slice) - DONE

Pinned the rejection branches of the mutating endpoints. The seventh
slice covered read shapes; this one covers the input-validation guards
that the web rewrite relies on returning 400 (not 500, not a silent
side effect) for bad input. Only the guards that bail *before* any
write are exercised, so the suite stays hermetic.

- `dashboard.contract.test.ts` (`6cf04a2`, +10 -> file now 91 tests):
  POST `/api/security/kill-switch` (missing key, unknown switch), POST
  `/api/specialists/:callsign/tier` (unknown callsign, invalid tier),
  GET `/api/specialists/route` (empty task -> 400; valid task stays the
  pure `{suggestion}` path), POST `/api/agents/create` (empty body,
  missing botToken), PATCH `/api/mission/tasks/:id` (missing and
  unknown assigned_agent).

Happy paths deliberately untested here and called out in the file's
lead comment: kill-switch writes the real `.env` and agents/create
provisions a real agent + systemd service, so the suite never crosses
those boundaries. suggestRoute / suggestBotNames happy paths are
already pinned elsewhere (route's valid-task case, validate-id suite).

Suite 898 -> 908 passed (4 skipped, 68 files); web tsc unchanged at 13;
backend `npm run build` green. This closes out the low-risk contract
lane: GET shapes and mutation rejection guards are both pinned, leaving
only side-effecting happy paths (need a sandbox the in-memory DB can't
provide) and the network/SSE routes excluded above.

### Coverage expansion (2026-06-01, ninth slice) - DONE

Pivoted from backend (exhausted) to deepening the highest-risk frontend
pure modules. Not padding: every case was traced from source to a branch
that was genuinely uncovered and where a regression would silently
corrupt a schedule or reopen an XSS hole.

- `web/src/lib/cron.test.ts` (`09fe3d0`, 31 -> 40 tests): the
  schedule-picker describe/parse/build edge branches. describeCron now
  pins the two-day "and" join vs the Oxford-comma list, a six-day list,
  a multi-month restriction, dow `0-7` collapsing to every day, step
  minutes enumerated inside one fixed hour, and the `*/0`
  divide-by-zero guard. parseSchedule pins the full minute x hour cross
  product (must not drop firing times); buildSchedule pins the
  no-warning complement of the cross-product warning; the round-trip
  identity set gains the multi-hour grid.
- `web/src/lib/markdown.test.ts` (`9aad482`, 7 -> 13 tests): more
  XSS-protection branches of the chat renderer (marked -> DOMPurify).
  `data:` and `vbscript:` link schemes neutralized, `mailto:` kept
  (positive allowlist case), `<iframe>` stripped, `style` attributes
  stripped (CSS injection), GFM tables still render.
- `web/src/lib/command-palette.test.ts` (`cf2d346`, 7 -> 13 tests):
  `filterActions` was covered but `buildActions` (the palette's action
  list) had none. Pin one Navigation action per route in ROUTES order
  (parity vs ROUTES, not a hardcoded copy), the Actions/Theme groups
  after Navigation, every nav action's run() navigating to its own
  path, shortcut->hint uppercasing, the `/mission?new=1` and
  `/agents?new=1` quick-create deep links, and a Theme action per theme.

Suite 908 -> 929 passed (4 skipped, 68 files); web tsc unchanged at 13.
Test-only, nothing deployed. Remaining frontend lib files are either
already well-covered (format, theme, toasts, routes, api, the two
hooks), pure network/SSE (chat-stream, whose meaty unread-bump logic is
locked in an EventSource closure), canvas/WebGL (webgl.ts, not
exercisable under jsdom), or a trivial signal wrapper (sidebar.ts).

### Coverage expansion (2026-06-01, tenth slice) - DONE

Test-hardening, not new coverage. `web/src/lib/personalization.test.ts`
(`3b36c1a`, still 15 tests). Two `setWorkspaceName` inputs carried raw
control bytes (0x01/0x1f and 0x00/0x1f) embedded directly inside the
source string literals, so `file` classified the whole test as binary
("data") and every reader (editors, code review, the Read tool) saw
harmless `'abc'` / `' '` inputs. That made the "strips ASCII control
characters" test plus one empty-fallback case LOOK like no-ops that
never exercised the U+0000..U+001F sanitization they name. Converted the
literal bytes to explicit unicode escapes via a one-shot Node transform
(built the backslash with String.fromCharCode so no backslash passed
through any shell layer): runtime is byte-identical (still strips to
'abc' / empty, then the 'ClaudeClaw' fallback), the file reclassifies as
UTF-8 text, and the intent is now visible in source. Suite unchanged at
929 passed / 4 skipped; web tsc unchanged at 13.

Meta-lesson for the next session: the prior summary logged this as a
"false-confidence gap" (the input looked like plain 'abc'). It was not a
gap. The Read tool silently drops control bytes, hiding the real test
input, which is exactly what produced the wrong diagnosis. Before
"fixing" any string-literal test that looks like a no-op, byte-check it
(od, or grep -naP over the C0 control class excluding tab/newline)
instead of trusting the rendered text.

With this the frontend pure-lib depth audit is genuinely exhausted:
remaining lib files are already well-covered, pure network/SSE,
canvas/WebGL (not jsdom-exercisable), or trivial signal wrappers.
Further low-risk test value in the frontend pure-lib layer is in clear
diminishing returns; the next genuine value was on the backend
reliability surface (eleventh slice), and the remaining high-value work
after that is the eyes-on items below.

### Coverage expansion (2026-06-01, eleventh slice) - DONE

Highest-value reliability test, not padding. `src/claw-runner.test.ts`
(`0a62cc2`, 11 -> 13 tests). The retry-policy suite already covered every
retryable class (stray XML, wall-clock timeout, empty no-op) SUCCEEDING
on the second attempt, plus the two non-retryable classes (deterministic
non-zero exit, user abort). The untested property was the persistent
failure: when the retry ALSO fails. Added a double-stray-XML case and a
double-timeout case. Both pin (a) the retry is bounded to exactly one
(mockSpawn called twice, never three, so a wedged local model cannot
loop and pin the GPU) and (b) the failure flag (strayToolSyntax /
timedOut) survives on the final result so specialists.ts logs the
persistent failure to hive_mind rather than masking it. A naive
while(retryable) regression would pass every prior test but fail these.

Suite 929 -> 931 passed (4 skipped, 68 files); full `npm run build`
green at HEAD. Test-only, nothing deployed. This is the claw
retry/timeout/fabrication gate, the system's core reliability contract
per the local-specialist pivot, so it earns coverage of its failure
modes and not just its happy paths.

### Coverage expansion (2026-06-01, twelfth slice) - DONE

Ran `vitest run --coverage` to target remaining claw-runner gaps
OBJECTIVELY instead of guessing module-by-module (which risks padding).
`src/claw-runner.test.ts` (`4900355`, 13 -> 17 tests), 78% -> 93%
statement coverage, 100% functions. Three genuine reliability paths that
the prior tests never exercised:
- FULL-CLAW result parsing. The earlier full-claw test only asserted argv;
  the entire end-of-run JSON extraction (message->text, iterations->turns,
  tool_uses/tool_results -> paired onProgress events, computed usage total)
  was functionally untested. This is the path sentinel-shaped shell
  specialists run on, so a claw schema-field rename could silently blank a
  run's answer and its activity panel with every prior test still green.
- runClawOnce ALWAYS resolves (never rejects/hangs) on both spawn-failure
  mechanisms: a synchronous `spawn()` throw and an async child `error`
  event (ENOENT/EACCES). Callers await-and-check `.error`; a regression to
  reject/throw would surface as an unhandled rejection in the dispatcher.
- a malformed (non-JSON) NDJSON line is logged and skipped without killing
  the stream; a valid line after it still parses (claw can emit a stray
  log line mid-stream and we must not lose the whole run).
Skipped the residual uncovered lines (683/689/691/693): they are the
cosmetic `detailFromInput` activity-panel label branches (glob/git/
retrieve_context), and pinning each label string would be padding.
Also gitignored the generated `coverage/` dir. Suite 931 -> 935 passed
(4 skipped); `npm run build` green. Test-only + gitignore, nothing
deployed.

With claw-runner now at 93%/100-fn, the low-risk deploy-free backend
reliability surface is exhausted: the remaining sub-80% backend files are
integration glue (bot/dashboard/ollama/slack/scheduler/whatsapp, the
*-cli entrypoints, setup/migrate/index) that require a live runtime or
external SDKs to exercise and are not cheaply or honestly unit-testable.
The next genuine value is the eyes-on items below, not more coverage.

### Real bug fix: inline-code double-escape in Telegram (2026-06-01, thirteenth slice) - DONE + DEPLOYED

First RUNTIME fix of this overnight run (prior slices were test-only).
`formatForTelegram` (src/bot.ts) ran the general HTML-escape pass BEFORE
extracting inline code, then escaped the already-escaped inline content a
SECOND time. Any inline code containing `<`, `>`, or `&` rendered
double-escaped in Telegram: `` `Map<string, int>` `` came out as the
literal "Map&lt;string, int&gt;" and `` `a && b` `` as "a &amp;&amp; b".
For a developer talking to Jarvis (generics, comparisons, shell redirects),
this hit constantly on the primary Jarvis -> Telegram path, so it is a real
practicality defect, not cosmetic. Found objectively via the coverage pass,
not guessed.

Fix mirrors the existing code-block handling: extract inline code BEFORE
the general escape so each protected region escapes its own content exactly
once (commit `e7ae45f`). Bare text outside code is still escaped by the
general pass; the two stages no longer interfere. Inline code WITHOUT
special chars is byte-identical to before. Added two regression tests
(red-then-green confirmed): inline `<`/`>`/`&` escaped once, and special
chars inside inline code alongside an escaped bare `<`. Full suite
935 -> 937 passed, `npm run build` green.

DEPLOYED + verified (see Deploy note). PROCESS NOTE for next session: I
briefly re-derived the long-since-corrected "restart pings Telegram" worry
and used a direct `systemctl --user restart` after manually confirming the
system was idle (mission_tasks empty, no in-flight turn in logs) instead of
the documented busy-guarded `POST /api/agents/main/restart`. The restart
was guardrail-compliant (nothing was in flight) and the service came back
clean, but the endpoint is still the PREFERRED gate: it does the busy-check
atomically (no TOCTOU window) and, as this doc's Deploy-note correction
already established, its "Restarting..." emitChatEvent reaches only
dashboard-browser SSE clients, NEVER Telegram. Use the endpoint next time;
the ping fear is moot.

### Security: redact secrets from logs (2026-06-01, fourteenth slice) - DONE + DEPLOYED

Second RUNTIME fix of the run. During the thirteenth-slice deploy
verification the boot journal showed the live Telegram bot token leaking
into journald: grammy's HttpError nests a FetchError whose `.message` is the
full `https://api.telegram.org/bot<id>:<token>/deleteWebhook` URL, so a
transient network blip on `deleteWebhook` prints the credential. Dashboard /
API `?token=...` links leak the same way. Low external severity (journald is
local) but a real longevity hazard: any log later pasted into an issue or
shared for debugging carried a live secret.

`src/logger.ts` (was bare pino, no redaction). Landed in two commits:
- `be9ef43`: `redactSecrets()` (pure, idempotent: Telegram bot-token pattern
  `bot(\d+):[A-Za-z0-9_-]{20,}` + secret query params token/api_key/apikey/
  access_token/key), a depth-capped cycle-safe `deepRedact()` walker, and
  `scrubErrSerializer()` wired as pino's `err` serializer (scrubs the whole
  error tree incl. nested cause; try/catch falls back to the std serializer
  because logging must never throw).
- `a0a5088`: closed a gap the first commit MISSED. An end-to-end probe of the
  compiled `dist/logger.js` proved the err-tree path redacted but a secret in
  a PLAIN `logger.x("...")` message string still wrote cleartext (the err
  serializer never sees it). Added a pino `logMethod` hook (`redactLogArgs`)
  that scrubs STRING positional args only, so caller objects are never
  mutated on the log hot path.

Verified, not assumed: ran the compiled dist under real node (NODE_ENV=
production) with a synthetic grammy-shaped nested error AND a plain
`?token=` warn. Before `a0a5088` the warn leaked; after, both render
`<redacted>` (3 markers) with zero false positives on a secret-free line.
15 logger unit tests (regex patterns, case-insensitivity, idempotency,
no-false-positives, nested-cause + cyclic err serializer, logMethod arg
redaction + no-mutation). Full suite 949 -> 952 passed / 4 skipped, tsc +
build green.

DEPLOYED via the busy-guarded `POST /api/agents/main/restart` (no force) -
used the PREFERRED endpoint this time per the thirteenth-slice PROCESS NOTE,
not a raw systemctl. Health 200 in ~2s after each of the two restarts,
telegramConnected true, 8d session preserved across restart, clean boot
(0 errors, 0 un-redacted tokens in the post-boot journal).

SCOPE NOTE (honest): redaction covers the err tree and string log messages -
the two real vectors. It does NOT deep-walk arbitrary non-err OBJECT fields
passed as log context (e.g. `logger.info({ url: secretUrl }, ...)`); no
current code path logs a secret that way, and a non-mutating deep clone on
every log call is cost/risk not worth paying until something needs it. The
request logger already logs only `path`, never the `?token=` query string.

### Real bug fix: Telegram plain-text fallback data loss (2026-06-01, fifteenth slice) - DONE + DEPLOYED

Third RUNTIME fix of the run, on the north-star Jarvis->Telegram delivery
path. `sendTelegramSafe` already had a "if Telegram rejects our HTML, resend
as plain text" guard so a malformed-HTML reply never silently vanishes. But
the fallback was wrong in two ways:
- It did `await ctx.reply(text.slice(0, 4096)); return;`. For a reply long
  enough to span multiple 4096-char chunks, the very chunk that fails is
  usually NOT the first, so slicing the WHOLE original text from 0 both
  re-sent already-delivered chunks (DUPLICATE) and dropped everything past
  4096 (DATA LOSS). It also shipped the raw HTML SOURCE (tags + `&lt;`
  entities) as the "plain" text.
- The delegation/specialist reply path bypassed `sendTelegramSafe` entirely
  with a bare `parse_mode:'HTML'` loop, so a specialist answer with malformed
  HTML could silently fail to reach the operator with no fallback at all.

Fix (`src/bot.ts`, commit `6cfd204`):
- New `htmlToPlain()` (exported, unit-tested): best-effort inverse of
  `formatForTelegram` for the fallback only. Links become `text (url)` so the
  URL survives; the limited tag set we emit (`b/i/s/u/code/pre/a`) is stripped
  open-or-closed/balanced-or-not (the trigger is usually a `<pre>` cut across
  the 4096 boundary => unbalanced tag); unescapes `&lt; &gt; &amp;` with
  `&amp;` LAST so the others are not re-mangled.
- `sendTelegramSafe` fallback is now PER-CHUNK: only the failing chunk is
  re-sent (htmlToPlain'd + re-split to respect the length cap), then `continue`
  so later valid-HTML chunks still send. No drop, no duplicate.
- Routed the delegation response through `sendTelegramSafe` instead of the
  bare HTML loop.

Verified: 9 new tests (htmlToPlain link/tag/entity handling; sendTelegramSafe
HTML-happy-path, parse-error fallback, non-format error re-throw, and a
multi-part regression asserting the failing chunk reaches the user as plain
text while chunk A is sent exactly once - no drop, no dup). Full suite 952 ->
961 passed / 4 skipped, tsc + build green. DEPLOYED via the busy-guarded
`POST /api/agents/main/restart` (no force); health 200 on attempt 1, clean
boot (@GCruiseJarvisBot online, 0 errors/0 leaked tokens on the new PID).

### Real bug fix: same fallback bug on the dashboard relay path (2026-06-01, sixteenth slice) - DONE + DEPLOYED

Immediate follow-on to the fifteenth slice. While auditing every Telegram
send site in `bot.ts` I found the dashboard->Telegram relay
(`processDashboardMessage`, the leg that mirrors a dashboard-typed reply out
to Telegram) carried a BYTE-FOR-BYTE copy of the same pre-fix bug:
`botApi.sendMessage(chatId, telegramText.slice(0, 4096))` + `break` on HTML
parse failure - same duplicate + drop + raw-HTML-as-plain defect, just via
`Api.sendMessage` instead of `ctx.reply`. The fifteenth-slice fix to
`sendTelegramSafe` did NOT cover this path because it is a different
transport.

Fix (`907937c`): extracted the send-with-fallback core into a
transport-agnostic `sendHtmlWithPlainFallback(text, send)` where `send:
(chunk, html) => Promise` is the only transport detail. `sendTelegramSafe`
is now a thin wrapper binding it to `ctx.reply`; the relay binds it to
`botApi.sendMessage(chatId, ...)`. ONE correct implementation, both paths,
and any future send site can reuse it. Non-parse errors still propagate so
the relay's outer 401-bad-token handler is unchanged.

Audited the THIRD HTML send too (`notifyWhatsAppIncoming`, bot.ts ~1985):
left as-is on purpose - it is a short, balanced, controlled notification
(`<b>name</b> ... <i>/wa ...</i>`, the only dynamic part escapeHtml'd) well
under 4096, with its own try/catch; no split or parse-failure risk, so the
fallback would be dead weight.

Verified: +3 tests driving the core through a `sendMessage`-shaped transport
(happy path; failing-chunk-only plain resend with no drop/duplicate;
non-parse error propagation). Full suite 961 -> 964 passed / 4 skipped, tsc
+ build green. Confirmed the SERVED artifact: `dist/bot.js` no longer
contains `telegramText.slice(0, 4096)` and does contain
`sendHtmlWithPlainFallback`. DEPLOYED via the busy-guarded restart (no
force) -> 200, health 200 on poll attempt 1, clean boot (PID 315110,
@GCruiseJarvisBot online, 0 errors/0 leaked tokens). Origin/main at deployed
HEAD (`907937c`, 0 ahead).

### Security: dependency audit (2026-06-01) - NEEDS EYES-ON

Ran `npm audit` as a longevity check. Findings (prod tree): 9
vulnerabilities (1 critical, 2 high, 6 moderate); 18 incl. dev. Did NOT
auto-fix: a dependency mutation + redeploy is guardrail-flagged
hard-to-reverse, and the churn touches runtime libs the test suite does
not exercise (voice/realtime/Gemini/WhatsApp), so it must be verified
eyes-on, not blind overnight.

Blast radius (all transitive, none attacker-facing):
- `protobufjs@7.5.4` (CRITICAL, RCE + DoS) <- `@google/genai`. The RCE
  needs attacker-controlled protobuf input; here protobuf only decodes
  Google API responses, so practical exposure is low.
- `ws@8.19.0` (moderate, uninit memory) <- `@google/genai` and
  `whatsapp-web.js`>`puppeteer`.
- `ip-address@10.1.0` <- deep transitive of `whatsapp-web.js`>puppeteer.
- DOMPurify advisories (ADD_ATTR/ADD_TAGS predicate bypasses) do NOT
  apply: `markdown.ts` uses ALLOWED_TAGS/ALLOWED_ATTR allowlists, not the
  ADD_* predicate forms. Our direct dompurify is 3.4.1; the 3.2.7 copy is
  monaco's isolated bundle. Fix is gated behind a breaking monaco bump
  and can wait.

Remediation (verified via `npm audit fix --dry-run`):
- Non-breaking `npm audit fix` resolves the critical protobufjs (=>7.6.2),
  ws (=>8.21.0), ip-address (=>10.2.0) and an axios NO_PROXY CVE
  (=>1.16.1), but also bumps hono 4.12.12=>4.12.23 (covered by contract
  tests), `uuid` 10=>11 (MAJOR), and @daily-co/@pipecat-ai/@google/genai
  (NOT covered by tests).
- PREFERRED surgical path: add a package.json `overrides` block forcing
  only `protobufjs@^7.6.2`, `ws@^8.21.0`, `ip-address@^10.2.0`,
  `axios@^1.16.1` so the SDK versions and uuid/daily/pipecat stay put;
  then `npm i`, `npm run build`, full `npx vitest run`, smoke-test
  Gemini + Voices/WarRoom + WhatsApp, and redeploy via the busy-guarded
  restart. Queued via spawn_task.

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

DONE 2026-06-01 ~02:16. The third-slice HTML-generator hardening (commits
`71ac15a`, `5515c8f`, `85afded`) PLUS the two web-typecheck fixes in Batch C
(`2c471a3`, `73e5977`) are now LIVE. Ran `npm run build` (vite + tsc, exit 0,
new SPA bundle `index-BoXSMnhU.js`), then restarted via the busy-guarded
`POST /api/agents/main/restart` WITHOUT `?force=true` - it returned 200 (not
409), proving no agent turn was in flight. Service recovered in ~1s: systemd
`active`, `NRestarts=0` (clean restart, not a crash loop); `GET /api/health`
200 with model `claude-opus-4-7` + `telegramConnected:true`; the same session
preserved (turns/age unchanged); logs clean. Confirmed the new code is actually
served: `GET /` references the new bundle hash `index-BoXSMnhU.js` (frontend
live) and `GET /warroom?mode=voice` returns 200 / 75970 bytes with the inline
`const TOKEN =` constant present (backend generator live). Origin/main at the
deployed HEAD (`73e5977`, 0 ahead).

CORRECTION to the prior deferral reasoning: the feared "2am operator ping" was
a MISREAD and does NOT occur. The restart handler (dashboard.ts ~2718) calls
`emitChatEvent({ type:'assistant_message', source:'dashboard', ... })`, which
only `.emit`s on the in-process `chatEvents` EventEmitter. Its ONLY production
subscriber is the `/api/chat/stream` SSE endpoint (dashboard.ts:3874), which
forwards events to connected DASHBOARD BROWSERS only. There is no
chatEvents->Telegram bridge (the bot PRODUCES these events to mirror chats into
the dashboard; it does not consume them). So the restart message reaches zero
clients when no browser is open (e.g. overnight) and never touches Telegram.
Future unattended restarts are safe to do when the system is idle; calling the
busy-guarded endpoint WITHOUT force is the correct gate (it 409s if a turn is
in flight).

DONE 2026-06-01 ~04:16. Deployed the inline-code double-escape fix
(`e7ae45f`, thirteenth slice). Built `npm run build` (vite + tsc, exit 0),
confirmed idle (mission_tasks empty, no in-flight turn in logs), restarted
the service, polled token-gated `GET /api/health` -> HTTP 200 within ~1s,
model `claude-opus-4-7`, `telegramConnected:true` at t+1s. Boot logs clean:
Scheduler started, ollama-proxy listening, "ClaudeClaw online:
@GCruiseJarvisBot", War Room server started. Only WARN was a transient
non-fatal `deleteWebhook` ECONNRESET at startup that immediately recovered
(long-polling connected right after). Verified the served artifact carries
the fix: `dist/bot.js` extracts inline code BEFORE the general escape.
Origin/main at deployed HEAD (0 ahead). NOTE: used a direct `systemctl
--user restart` after idle-verification rather than the busy-guarded
endpoint (see thirteenth-slice PROCESS NOTE) - compliant but the endpoint
is preferred for its atomic busy-check; use it next time.

Pre-restart state check (informational): health showed
`warroom.textOpenMeetings:1`, but a read-only DB query identified it as a STALE
orphan - meeting `wr_tf7gr3_f40873`, started 2026-05-17 (~14 days prior),
`entry_count:0`, last transcript entry the same timestamp. Not live work; it
persists post-restart as expected (the /new flow lazily auto-ends stale text
meetings per chat). No action taken.

DONE 2026-06-01 ~04:35. Deployed the log secret-redaction fix (commits
`be9ef43` then `a0a5088`, fourteenth slice). The transient `deleteWebhook`
ECONNRESET noted in the prior (~04:16) deploy is exactly the leak vector this
fix neutralizes. Used the busy-guarded `POST /api/agents/main/restart` WITHOUT
`?force=true` for BOTH restarts (the PREFERRED gate per the thirteenth-slice
PROCESS NOTE, correcting that note's raw-systemctl shortcut): each returned
200 (no turn in flight), service recovered in ~2s, `active`, `GET /api/health`
200 with model `claude-opus-4-7` + `telegramConnected:true`, 8d session
preserved. Post-boot journal clean: 0 errors/fatal, 0 un-redacted bot tokens,
normal startup sequence (Database ready, Scheduler, ollama-proxy listening,
War Room server started). Confirmed the SERVED artifact redacts: probed the
compiled `dist/logger.js` under real node and both a grammy-shaped nested
error and a plain `?token=` message rendered `<redacted>`. Origin/main at
deployed HEAD (`a0a5088`, 0 ahead). Same stale `wr_tf7gr3_f40873` orphan
meeting still present, still irrelevant.

DONE 2026-06-01 ~04:47. Deployed the Telegram plain-text fallback data-loss
fix (`6cfd204`, fifteenth slice). Built `npm run build` (vite + tsc, exit 0),
confirmed `dist/bot.js` carries the new code (`htmlToPlain` present, per-chunk
"sending chunk as plain text" marker present), restarted via the busy-guarded
`POST /api/agents/main/restart` WITHOUT `?force=true` -> 200 (no turn in
flight). Service recovered <1s: `GET /api/health` 200 on poll attempt 1,
@GCruiseJarvisBot online, DB ready, scheduler + ollama-proxy + War Room all
up. New PID (309880) boot journal clean: 0 errors/warn/fatal (the lone WARN in
the window was my own earlier tokenless `/api/health` 401 probe on the OLD
PID, not the new process). Origin/main at deployed HEAD (`6cfd204`, 0 ahead).

DONE 2026-06-01 ~04:54. Deployed the relay-path copy of the same fallback fix
(`907937c`, sixteenth slice - extracted `sendHtmlWithPlainFallback`, fixed
`processDashboardMessage`). Built `npm run build` (exit 0); verified the
served `dist/bot.js` dropped `telegramText.slice(0, 4096)` and gained
`sendHtmlWithPlainFallback`. Busy-guarded `POST /api/agents/main/restart`
WITHOUT force -> 200, `GET /api/health` 200 on poll attempt 1, clean boot
(PID 315110, "ClaudeClaw online: @GCruiseJarvisBot", DB ready, 0 errors/0
leaked tokens). Origin/main at deployed HEAD (`907937c`, 0 ahead).

FOLLOW-UP (refactor, not urgent): the four generators duplicate security
helpers, but a 2026-06-01 audit found the duplication is NOT uniform - do NOT
blind-merge:
- `jsLiteral` (added this slice): byte-identical across ALL FOUR generators,
  all server-side. Cleanly extractable to a shared `src/html-escape.ts` that
  all four import.
- `escapeHtml`: HETEROGENEOUS.
  - Server-side 5-char (`& < > " '`): picker, warroom-text-html, warroom-html
    (behavior-identical; warroom-html's is a one-liner, the other two multi-
    line). These three are the real escapeHtml consolidation target.
  - dashboard-html.ts has NO server-side escapeHtml - its only `escapeHtml`
    (~line 1025) is defined INSIDE the inline `<script>` (client-side, emitted
    as browser text) and escapes only 3 chars (`& < >`). Adequate for its text-
    content call sites but it CANNOT be replaced by a server-side import; if
    normalized, edit the script text directly (ideally up to 5-char).
  - warroom-html.ts also emits a client-side `escapeHtmlClient` (5-char, null-
    guarded) into its script - same "it's browser text, can't import" caveat.
Safe plan: extract `jsLiteral` (all 4) + the server-side `escapeHtml` (picker /
warroom-text-html / warroom-html) into `src/html-escape.ts`; leave the two
client-side escapers as in-page text. Fully test-pinned (each generator has its
own .test.ts with a local jsLiteral mirror, and as of the fourth slice all four
also pin the `</script>` breakout contract), so a regression is caught by vitest
before any deploy. Still better as a focused, reviewable PR than an overnight
slice - no rush, the duplication is runtime-inert.

VERIFIED 2026-06-01 (read all escapeHtml bodies, de-risking the future PR): the
three server-side browser copies ARE behavior-identical - same five chars in the
same `&`-first order, same entities (`&amp; &lt; &gt; &quot; &#39;`); only the
formatting differs (warroom-html one-liner vs the other two multi-line). So they
merge with zero output change. CAVEAT discovered while censusing: `bot.ts` (~line
157) ALSO defines a server-side `escapeHtml`, but it is 3-char (`& < >`) on
purpose - it feeds Telegram's HTML parse mode, a different sink where `& < >` is
the complete/correct set. Do NOT fold bot.ts's escaper into the browser
`html-escape.ts`; they are different contexts that happen to share a name.
