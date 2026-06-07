# Handover - 2026-06-02 (research team: regular + abliterated cross-check)

Branch `main`. Build + deploy authorized via the busy-guarded restart endpoint.
Gabe's ask: "setup the research agent and research analysis agents, abliterated
model research agent as well for fully uncensored research ... we want the regular
agents but we also want a team of abliterated agents as well to cross reference
all of the regular agents findings for any biases and censorship or maybe false
information due to their guardrails. we want both." He chose, when asked, the
Jarvis-orchestrated specialist model (not standalone bots) and the **hybrid with
auto-escalation** abliterated strategy.

## The hardware constraint that shaped the design

GPU is an **RTX 5080 with 16 GB VRAM**. The big abliterated models overflow it and
run partly on CPU (slow): Qwen3.6-abliterated 35b = 23GB, 27b = 17GB, qwen3-32b-q8
= 34GB, llama3.3-70b-q2 = 26GB. You **cannot run multiple large abliterated models
in parallel**. Models that fit: neuraldaredevil-8b (5.6GB), gemma-4-abliterated
(9.6GB), mistral-small-abliterated (14GB). So the abliterated cross-check team uses
SMALL models for routine runs and escalates to reaper's 35b only for high-risk
findings.

## Roster added (3 specialists -> 13 total)

| Callsign | Side | Tier | Model | Job |
|---|---|---|---|---|
| **prism** | regular | cloud | claude-sonnet-4-6 | research analysis: source grading, claim verification, structured synthesis |
| **oracle** | abliterated | claw | huihui_ai/gemma-4-abliterated:latest (9.6GB) | uncensored research, same question as sleuth, no guardrails |
| **heretic** | abliterated | local | closex/neuraldaredevil-8b-abliterated:latest (5.6GB) | bias/censorship auditor: diffs regular vs uncensored, flags distortions |

reaper (existing, abliterated 35b) is kept as the deep-dive escalation target.

## 1. `src/specialists.ts`

- Union `SpecialistCallsign`: added `prism`, `oracle`, `heretic`. `ALL_CALLSIGNS`
  auto-derives from `Object.keys(SPECIALISTS)`, so no manual edit there.
- `SPECIALISTS` record: three new entries (full configs, tuned system prompts).
  - **prism**: cloud Sonnet 4.6, `expectsToolUse` unset (analysis over provided
    material is legitimately tool-less), qwen3-coder local fallback.
  - **oracle**: claw, primary gemma-4-abliterated, fallbacks mistral-small-
    abliterated then neuraldaredevil-8b. `expectsToolUse` UNSET on purpose (same
    as reaper: abliterated models rarely emit tool_calls, so forcing the
    unverified label is noise; grounding comes from the injected SEARCH RESULTS).
  - **heretic**: **local tier** (direct Ollama, no claw tool loop) because its job
    is pure reasoning over two provided answer-sets, which is reliable for small
    models unlike the claw loop. neuraldaredevil-8b primary.
- Brave prefetch gate (delegate dispatch): extended from `callsign === 'sleuth'`
  to also include `'oracle'`, so oracle gets the same `[SEARCH RESULTS]` injection
  and stays grounded even when the abliterated model does not browse.
- `ROUTING_RULES`: added multi-word keys for the three (e.g. "research analysis",
  "uncensored research", "bias check"). Multi-word on purpose so a plain
  "research X" still routes to sleuth. The dual-track flow itself is Jarvis-driven
  (persona recipe), not these single-pick keywords.
- Router roster prompt (Stage-2 routing brain): added prism/oracle/heretic lines
  with model annotations.

## 2. Jarvis persona `~/.claudeclaw/CLAUDE.md` (synced, NOT in the repo)

Doctrine-only edits (SOUL / STYLE / voice / truth rules untouched), authorized as
part of Gabe's explicit request to build this team (without the persona update
Jarvis would not use the new specialists):
- "Your team" header 10 -> 13; tier intro now lists reaper/oracle/heretic/eye as
  the local set; claw-tier "Used by reaper and oracle"; local-tier "Used by eye
  and heretic"; three new roster rows.
- New subsection **"Dual-track research (regular team plus an uncensored
  cross-check)"**: the 4-step recipe (both tracks in parallel -> analyze +
  cross-check in parallel, both finding-sets passed into heretic's context ->
  auto-escalate HIGH-risk flags to reaper -> synthesize a "Censorship / Bias
  Delta" section), plus the GPU-reality note. No em dashes.

## 3. Tests `src/specialists.test.ts`

Added a 7-test block: prism/oracle/heretic registered with correct tier+model+
capabilities; the abliterated models stay within the 16GB budget (vramHint
assertions); ALL_CALLSIGNS contains all three; each routes by its own keywords;
and the existing single-domain routes (sleuth/scribe, coder) are undisturbed.

## How the dual-track flow runs (the product)

1. `delegate_parallel`: sleuth (regular, cloud, Brave) + oracle (uncensored,
   abliterated) on the SAME question, at once.
2. `delegate_parallel`: prism analyzes the regular findings; heretic diffs regular
   vs oracle and flags bias/censorship/false-info, each low/medium/high. Jarvis
   passes BOTH finding-sets into heretic's context (heretic has no web access).
3. Any HIGH-risk flag -> `delegate` reaper (35b) for a deep uncensored re-check.
4. Jarvis synthesizes one answer with a "Censorship / Bias Delta" section.

Peak local GPU load in this recipe is ONE small model at a time (oracle in step 1,
heretic in step 2), so 16GB is never contended; reaper's 35b runs alone in step 3.

## Build + deploy + live verification

- `npm run build` (vite + tsc) GREEN. Full suite GREEN: 72 files, 1014 passed /
  4 skipped (up from 1007; +7 new tests). Typecheck clean.
- Deployed via `POST /api/agents/main/restart` (busy-guarded). Health: model
  claude-opus-4-8, telegramConnected true. `/api/specialists` now lists **13**;
  prism (cloud/Sonnet), oracle (claw/gemma-4-abliterated), heretic
  (local/neuraldaredevil-8b) all `available: true`.
- One transient `deleteWebhook` FetchError at boot (Telegram API network blip),
  self-recovered; telegram stayed connected, not a reconnect loop. Unrelated to
  this change.

## Status

Complete, deployed, verified live. Mission Control auto-reflects the 13 (the
Specialists page reads `/api/specialists`). Not yet exercised end-to-end: a real
dual-track research run through Telegram (will happen on Gabe's next research
request). Naming (prism/oracle/heretic) is easily changed if Gabe wants different
callsigns. Code comments tag this slice "2026-06-02 research team".
