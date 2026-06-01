# Handover - 2026-05-31 (overnight 3-phase autonomous run)

Living progress doc for the approved ~8h overnight run. Updated at each
phase checkpoint so the next session bootstraps from truth. Working on
branch `main`, committing locally in logical chunks, NOT pushing (push
is classifier-gated and was not requested).

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

## Phase 2 - Mission Control completion (NOT STARTED)

- Surface `GET /api/mission/history` archive view.
- Mount the dead `TaskDetailsModal` + `GET /api/mission/tasks/:id`.
- Floor card drill-in.
- Reassign via `PATCH /api/mission/tasks/:id`.
- Priority queue view.

## Guardrails in force

No push. No PC restart / plugin install / permission-OAuth / `.env` /
Jarvis-persona edits without explicit approval. No mock data. No
em/en dashes. Intelligence > cost (Max plan; cloud Claude is default for
main Jarvis, local for specialists per the 2026-05-25 pivot).

## Deploy note

The live service still runs old in-memory code. Deploying any of this to
Jarvis needs `systemctl --user restart com.claudeclaw.main.service` -
NOT done (deploy is a separate decision, and the run is mid-flight).
