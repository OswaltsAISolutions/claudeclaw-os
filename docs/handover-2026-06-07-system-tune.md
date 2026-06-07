# Handover - 2026-06-07 (full system tune from Gabe's interview)

Gabe answered a 20-question interview (who he is + what he wants from Jarvis), then:
"work fully autonomously... configure/setup my ultimate system... when I return it
should all be done." This slice captures his profile + mission, rewrites Jarvis's
personality, and executes the readiness-plan fixes. The persona and memory files are
live-config (NOT in the repo); the code changes are committed.

## Who Gabe is (now captured durably)

Self-taught AI builder, NOT a coder (team owns all code). EST. Day job: manual labor
at Good Nature Organic Lawn Care (Cleveland OH), wants to become their AI guy (first
consulting client). Dad = career Green Beret (his patriot roots). The main event:
full-time truth-seeking content creation, handle **GCruise** (YouTube/X/IG/TikTok,
from zero), lane = AI + American politics + the deep state + exposing foreign control
of US gov/business/media, independent and non-partisan, Julian-Dorey/Jake-Shields/
Andrew-Tate tier. Target >= $10k/mo. Tracks: Research > Content > Consulting > Building.
Hard wants: truth without theatrics, never refuse a taboo research topic, never spend
money / post / share private info without approval, full PC access otherwise, work
autonomously without constant check-ins, dashboard+Telegram parity.

Captured in: `~/.claudeclaw/CLAUDE.md` (persona), `memory/user_gabe.md`,
`memory/mission_north_star.md`, `memory/MEMORY.md` index.

## Persona rewrite (CLAUDE.md, live-config; explicitly authorized by Gabe)

- New `## MISSION` section (north star: make Gabe win; full-time GCruise content,
  clients, deep uncensored research; track priority Research>Content>Consulting>Building;
  be the operator who proposes the highest-leverage next move).
- Deeper SOUL/Identity: from "voice" to character (drive to multiply Gabe, standards
  he defends, loyalty, truth-seeker who never flinches at taboo).
- Rewrote "Who Gabe is" with the real profile.
- New "Rules - proactivity + device parity" (bootup brief, finished-work rundowns,
  ~2am Telegram recap, dashboard+Telegram always in sync and equal).
- New "Rules - autonomy + guardrails" (work autonomously; full PC access; never spend
  money / post / share-private without approval; never plot/keep-secrets/talk-to-other-AI
  without approval; never refuse taboo research, use oracle/heretic/reaper).
- Operating mode + jobs reordered to Research/Content/Consulting/Building with his
  quality bar baked in.
- Fixed Tavily->Brave (the persona told Jarvis to use a provider that is not wired).
- Reconciled the two delegation surfaces: native `team` tools (delegate /
  delegate_parallel) are now the clear DEFAULT; the `auto` CLI is demoted to secondary
  so it cannot re-collapse a multi-part task.

## Readiness-plan fixes (committed code)

1. **Cloud temperature "bug" investigated and documented, not faked.** The Agent SDK
   exposes NO temperature option (only `extraArgs`, a raw CLI passthrough with no
   `--temperature` flag). So `spec.temperature` cannot be applied on the cloud path;
   it governs local/claw only. Documented in `delegateCloud` + the field comment.
   Cloud quality is tuned via prompt + model instead (done below). The audit's
   "one-line fix" was not possible; faking it (extraArgs guess) risked breaking every
   cloud call, so it was not shipped.
2. **Memory cleanup.** Purged 7 pinned health-check/smoke-test memories (ids 19, 22-27)
   that were crowding the 2-slot CORE block at importance 0.95; cleaned the
   consolidations about them. memories table 20 -> 13, CORE now surfaces real facts.
   The 5 missing-embedding rows were left (old/redundant now that the profile is in the
   always-injected persona; backfill = low value). The ingestion stall is by design
   (selective extraction, correct), not a bug; added one extraction-prompt bullet to
   bias capture toward Gabe's business/content/research facts. `src/memory-ingest.ts`.
3. **Research/analysis/planning rigor** (`src/specialists.ts`):
   - Shared `HIVEMIND_PREAMBLE`: new RULE 4 (RIGOR + CALIBRATION): ground or label
     unverified, lead with the bottom line, structure, calibrate confidence, contrarian
     only when warranted and never invent a counter-narrative, tool-less locals still
     ground. Every agent inherits it.
   - **sleuth**: triangulation (2+ sources, [single-source] label), source weighting,
     follow links, output contract (BOTTOM LINE / KEY FINDINGS+URLs / CONFIDENCE /
     OPEN QUESTIONS).
   - **prism**: A/B/C source-grading scale, overall confidence, EVIDENCE GAPS.
   - **atlas**: fixed the self-contradiction (stop-after-first-result vs inspect-before-
     planning) by conditioning it on task shape, and added a plan-format contract
     (GOAL / CONSTRAINTS+ASSUMPTIONS / STEPS w/ owners / RISKS / DONE-CRITERIA).
   - **cipher**: report n/units/method, no causation-from-correlation, no unsupported
     patterns. **reaper**: knows it is the HIGH-risk deep-dive escalation. **archivist**:
     concrete keep/drop rule. **scribe**: {audience/format/length/tone} contract +
     write in Gabe's GCruise voice; bumped local-fallback ctx 8192 -> 16384.
   - Web-source budget raised: Brave prefetch count 5 -> 8 and snippet 240 -> 500
     (endpoint snippet cap 280 -> 500), so the snippet-only uncensored oracle has more.
4. **Model muscle**: sleuth + prism upgraded to **Opus 4.7** (deep research + analysis;
   intelligence-first, cost-last). oracle + heretic deliberately KEPT local-abliterated:
   moving them to cloud would censor the uncensored cross-check and defeat Gabe's core
   truth-uncovering value. Router roster + persona table + the prism test updated.
5. **Routing**: tightened brittle substring keywords that would misroute Gabe's
   politics/finance content (removed coder 'function'/'class '/'bug'; sentinel 'log'/
   'service'/'crash' -> infra-specific 'log file'/'crash log'/'systemctl'). Multi-domain
   tasks still escalate to self -> team tools.
6. **Proactivity**: created the nightly **2am recap scheduled task** (id 69bb60e4,
   `0 2 * * *`, server TZ is America/New_York = Gabe's time). Device parity confirmed:
   dashboard chat and Telegram both key off ALLOWED_CHAT_ID, so they share one
   conversation + session (no desync by design).

## Build + deploy + verify

Typecheck + build + full suite GREEN (73 files, 1022 passed / 4 skipped). Deployed via
busy-guarded restart, clean boot. Health: opus-4-8, telegram connected. /api/specialists:
sleuth + prism = Opus 4.7, oracle + heretic = local abliterated, all available. Scheduled
task active. Earlier in the day the Section 224 dual-track run already completed end to
end (~8 min, 13.8 KB report) after the timeout fix, proving the pipeline.

## Not done (honest)

- A full per-agent quality BENCHMARK on real tasks (Tier 4 #13) was not run. It is best
  judged WITH Gabe on topics he cares about; the synthetic version adds little. This is
  the natural next step before fully trusting big projects.
- Cloud temperature remains uncontrollable (SDK limitation, documented).
- The 5 embedding-less memories were left (low value).
- Full readiness detail: `docs/readiness-plan-2026-06-06.md`.
