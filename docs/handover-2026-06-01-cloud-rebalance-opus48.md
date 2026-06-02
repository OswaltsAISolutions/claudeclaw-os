# Handover - 2026-06-01 (specialist cloud rebalance + Jarvis Opus 4.8)

Branch `main`. Same standing authority as the overnight run: work
"pushed implimented, and implimented correctly without breaking anything
else." Build + deploy authorized; done in verified increments via the
busy-guarded restart endpoint.

Two coupled changes shipped together this slice, built once, deployed
once, boot-verified on the live WSL systemd user service.

## 1. Specialist model rebalance (role-fit, not one-size-fits-all)

**Trigger:** Gabe asked why "all agents" were on qwen3-coder:30b (it was
7 of 10, verified against live `/api/specialists`, not memory), then:
"his subagents should be using models that help them specifically with
their specialist role," and confirmed Sonnet 4.6 beats the local qwen
models at tool/reasoning work. Chose the hybrid (Gabe picked
"Tool/reasoning roles → cloud").

**What changed in `src/specialists.ts`:** 7 tool/reasoning specialists
flipped `tier: 'claw' → 'cloud'`, each given a `localFallbackModel:
'qwen3-coder:30b'` for graceful quota-exhaustion degradation.

| Callsign | tier | preferredModel (now) |
|---|---|---|
| coder | cloud | claude-sonnet-4-6 |
| sleuth | cloud | claude-sonnet-4-6 |
| archivist | cloud | claude-sonnet-4-6 |
| sentinel | cloud | claude-sonnet-4-6 |
| cipher | cloud | claude-sonnet-4-6 (cloudModel was Opus 4.7) |
| mercury | cloud | claude-sonnet-4-6 |
| atlas | cloud | claude-opus-4-8 (heaviest reasoning; tracks main) |
| scribe | claw | huihui_ai/Qwen3.6-abliterated:27b (unchanged) |
| reaper | claw | huihui_ai/Qwen3.6-abliterated:35b (unchanged) |
| eye | local | qwen3-vl:8b (unchanged) |

**Why these three stay local:** reaper is uncensored/red-team work that
cloud models REFUSE (that is the whole reason it exists); eye is vision;
scribe is prose. The four read/research/sysadmin/data roles moved to
cloud because bake-off v3/v4 proved the local abliterated/mistral models
fabricate tool results instead of calling tools. Cloud SDK tool use is
the reliable fix.

**CONSEQUENCE to remember:** cloud delegate runs with
`permissionMode: 'bypassPermissions'` (full bash/write). The old claw
`read-only` sandbox no longer constrains sleuth/archivist/sentinel/
cipher. Sentinel's systemPrompt destructive-op-confirmation rule is now
the only guardrail (noted in its code comment). Reversible via a
per-specialist tier override back to claw.

## 2. Jarvis main → Opus 4.8

**Trigger:** "get him to opus4.8 since it recently came out."

Bumped every place the north-star default resolves, plus the consistency
points:
- `bot.ts` AVAILABLE_MODELS.opus and the `effectiveModel` fallback
  (`?? 'claude-opus-4-8'`). Main has no agent.yaml, so this hardcoded
  fallback IS Jarvis's durable default.
- `dashboard.ts` validModels (both PATCH endpoints — added 4-8, kept 4-7
  selectable) and the three display fallbacks.
- `specialists.ts` atlas (preferred + cloudModel), the intelligentRoute
  Stage-2 router, reaper's escalation cloudModel, and the user-facing
  router reason strings.
- `dashboard-html.ts` (legacy UI) + `agent-create.ts` new-agent default.

Smart-routing-to-Haiku for trivial acks is UNCHANGED and still applies to
simple messages. It is a separate cost optimization, not the intelligence
default; the complex/default path is now Opus 4.8.

**De-risk before deploy:** wrote a throwaway probe that called the SDK
`query()` with `model: 'claude-opus-4-8'` through the live OAuth Max
creds. Result: `usedModel=claude-opus-4-8 reply="PONG"`. Model ID is real
and accepted. Probe deleted after.

## Tests

7 stale-config failures in `src/specialists.test.ts`, all because the
tests used `sentinel` as the vehicle for claw-path behavior and sentinel
moved to cloud. Fixed by intent, not by reverting config:
- The 4 claw-tier honesty-labeling tests now push sentinel back to claw
  via a runtime tier override in `beforeEach` (cloud→claw swaps
  preferredModel ← localFallbackModel = qwen3-coder:30b and preserves
  `expectsToolUse`, recreating the exact original scenario). Test bodies
  unchanged.
- The 3 `resolveSpecialistModel` tests repointed to `reaper` (the
  remaining statically-claw specialist) and its real Ollama fallback
  chain (35b → 27b → null).

Full suite GREEN: 991 passed / 4 skipped / 71 files. `npm run build`
(vite + tsc) GREEN.

## Deploy + verification (live)

Deployed via `POST /api/agents/main/restart` (busy-guarded). Post-restart:
- `/api/health`: `model: claude-opus-4-8`, telegramConnected true.
- `/api/agents`: main `model=claude-opus-4-8`, running.
- `/api/specialists`: all 10 match the table above, every one
  `available: true`, `modelInUse == preferredModel`.

## Status

Both changes complete, deployed, verified. Not yet committed/pushed to
git as of this writing (source + dist built and live). Next: commit in
two logical chunks (rebalance, opus-4.8) and push. Nothing in this slice
left to design or re-investigate.
