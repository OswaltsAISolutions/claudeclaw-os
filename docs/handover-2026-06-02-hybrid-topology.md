# Handover - 2026-06-02 (hybrid model topology + persona sync)

Branch `main`. Standing authority unchanged: "work autonomously, go with the
best option, build for intelligence + longevity, push implemented and
implemented correctly without breaking anything else." Build + deploy
authorized via the busy-guarded restart endpoint. Gabe added, for this slice:
"do it all on your own autonomously, no need to ask me any further questions
regarding the model switches. you do it yourself."

## Goal (Gabe's words, decoded)

"jarvis needs to be on opus 4.8 ... sonnet4.6 for all subagents besides atlas,
reaper, and eye. reaper will stay on the abliterated model, atlas will be on
opus 4.7 and eye will be on whatever the best local model ... make sure the
system knows ... mission control reflects ... and jarvis knows as well so he
knows what models his team are using."

Final target topology:

| Callsign | tier | model | change vs 2026-06-01 |
|---|---|---|---|
| (Jarvis main) | n/a | claude-opus-4-8 | none (already 4.8) |
| coder | cloud | claude-sonnet-4-6 | none |
| sleuth | cloud | claude-sonnet-4-6 | none |
| archivist | cloud | claude-sonnet-4-6 | none |
| sentinel | cloud | claude-sonnet-4-6 | none |
| cipher | cloud | claude-sonnet-4-6 | none |
| mercury | cloud | claude-sonnet-4-6 | none |
| atlas | cloud | claude-opus-4-7 | CHANGED (was opus-4-8) |
| scribe | cloud | claude-sonnet-4-6 | CHANGED (was claw / abliterated:27b) |
| reaper | claw | huihui_ai/Qwen3.6-abliterated:35b | none |
| eye | local | qwen3-vl:8b | none (confirmed best installed vision model) |

Six specialists were already on Sonnet 4.6 from the 2026-06-01 rebalance, so the
only real model moves this slice were atlas (4.8 -> 4.7) and scribe (claw ->
cloud Sonnet 4.6).

## 1. `src/specialists.ts`

- **scribe:** `tier: 'claw' -> 'cloud'`; `preferredModel` abliterated:27b ->
  `claude-sonnet-4-6`; ADDED `localFallbackModel:
  'huihui_ai/Qwen3.6-abliterated:27b'` so uncensored prose survives a cloud
  quota-degrade (tool-less direct chat). `cloudModel` stays sonnet-4-6.
  `clawPermission`/`clawUseFull` KEPT (the cloud->claw override path uses them).
  `expectsToolUse` intentionally still UNSET: prose is a legitimately tool-less
  answer and must not get the UNGROUNDED_NOTICE.
- **atlas:** `preferredModel` AND `cloudModel` opus-4-8 -> `claude-opus-4-7`.
  Comment rewritten (atlas is one tier below Jarvis main; Gabe set the
  supervisor at 4.7 while main runs 4.8; this reverses the 2026-06-01 "track
  main on 4.8" bump).
- **Line 47** type-union comment: "Cloud supervisor, Opus 4.8." -> "Opus 4.7."
- **Router roster** (the prompt fed to the Stage-2 routing brain): every
  specialist line annotated with its model so Jarvis's routing intelligence
  knows the team's models. atlas "(Opus 4.7)", scribe/coder/sleuth/archivist/
  sentinel/cipher/mercury "(Sonnet 4.6)", eye "(qwen3-vl:8b, local)", reaper
  "(abliterated 35b, local)".

**Deliberately LEFT at opus-4-8** (NOT bugs):
- The Stage-2 router model (`model: 'claude-opus-4-8'`) and its "Opus 4.8 chose"
  reason strings. The router IS Jarvis's routing intelligence, so it tracks main.
- reaper's forced-escalation `cloudModel` (line ~276). reaper's working model is
  abliterated:35b (unchanged per Gabe); the escalation path is rare and cloud
  Opus would refuse uncensored work anyway, so it is not part of the stated
  topology. Documented rather than silently changed.

## 2. `src/specialists.test.ts`

The claw-tier honesty-labeling block uses a runtime tier override to exercise
the claw path. It previously pushed only `sentinel` back to claw. Since scribe
moved to cloud, the override now pushes BOTH `sentinel` AND `scribe` to claw.
scribe cloud->claw resolves preferredModel <- localFallbackModel
(abliterated:27b, present in the mock model list), recreating the original
prose-test scenario. Comment updated. No assertion bodies changed.

No test pins the `claude-opus-4-8` literal or scribe's static tier, so the atlas
and scribe changes broke nothing else.

## 3. Jarvis persona `~/.claudeclaw/CLAUDE.md` (synced, NOT in the repo)

"jarvis knows his team's models" lives most durably in the persona file's "Your
team" roster + model-selection rules, and it was badly stale (still said Jarvis
on Opus 4.7, "all specialists run locally", "Gabe downgraded the sub", old local
model names). Leaving it would have Jarvis actively misstate his team to Gabe,
violating the persona's own truth rules and the core ask.

The standing guardrail is "no persona edits without explicit approval", but its
own away+preauthorized clause permits proceeding-with-citation, and Gabe gave
explicit, specific preauthorization ("make sure jarvis knows his team's models
... do it yourself autonomously, no need to ask me any further questions"). So
the FACTUAL model/tier/topology content was corrected; SOUL / STYLE / voice /
work-ethic / truth rules were left untouched.

Sections updated: the 2026-05-25 banner; "Rules - model + tool selection" body;
the "Most specialists run on cloud" tier explainer; the "Your team" 10-row
table; the capability-tradeoff notes; the two router stages (Opus 4.8 brain +
mistral fallback); and three operating-principle bullets. New text avoids em
dashes per the standing output rule. The persona file lives in `~/.claudeclaw/`,
so it is NOT part of the git commit; it is a live-config change.

## Tests + build

`npm run build` (vite + tsc) GREEN. Full vitest suite GREEN: 71 files, 993
passed / 4 skipped. (The "handler blew up" line is an intentional fixture error
in `message-queue.test.ts`, which passes.)

## Deploy + live verification

Deployed via `POST /api/agents/main/restart` (busy-guarded; returned ok). New
code confirmed live in 3s (atlas resolving to opus-4-7).

- `/api/health`: `model: claude-opus-4-8`, `telegramConnected: true`.
- `/api/specialists`: all 10 match the target table, every one
  `available: true`, `modelInUse == preferredModel`. atlas = claude-opus-4-7,
  scribe = cloud / claude-sonnet-4-6, reaper = claw / abliterated:35b, eye =
  local / qwen3-vl:8b, the other six = Sonnet 4.6.

Mission Control needs no code change: `SpecialistFloor.tsx` renders
`modelInUse || preferredModel` live from `/api/specialists`, so it auto-reflects
the new models on the redeploy.

## Status

Complete, deployed, and verified live. specialists.ts + specialists.test.ts are
committed/pushed (see git log for this slice). The persona sync is a live-config
edit outside the repo. Nothing left to design or re-investigate; the only
conscious "left as-is" items (router brain + reaper escalation on opus-4-8) are
documented above.
