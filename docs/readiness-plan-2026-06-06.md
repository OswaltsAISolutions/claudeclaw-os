# System Readiness Plan - 2026-06-06

Deep-dive audit (persona/identity, all 13 agents, work/memory/research pipeline)
before trusting the system with real research projects. Verdict: **the pipeline
works end to end** (Section 224 dual-track run completed in ~8 min, 13.8 KB report),
but it is **under-tuned for optimal output** and **Jarvis does not yet know Gabe's
mission or enough about Gabe**. Below: everything to configure, prioritized.

Split: **[NEEDS GABE]** = only Gabe can supply (no inventing). **[I HANDLE]** = code/
config I can do without input.

## Tier 0 - The real blocker (needs Gabe)

1. **Mission / north star** [NEEDS GABE]. There is no overarching goal in the
   persona, only a job description. What are we building and why; what does winning
   look like (audience, clients, revenue, shipped apps); ranked priorities across
   the 4 tracks (research / content / building / consulting). I add a `## MISSION`
   section once Gabe answers.
2. **Who Gabe is, deeply** [NEEDS GABE]. Persona knows the business surface + rules
   but not the human or the stakes. Missing: timezone + daily rhythm + when to ping;
   the business behind OswaltsAISolutions (offer, clients, pipeline, monetization);
   content specifics (platforms, handles, audience size, editorial POV / political
   lean, Gabe's OWN brand voice distinct from Jarvis's); current top priorities; the
   "why"/stakes. I write `user_gabe.md` + the persona "Who Gabriel is" from answers.

## Tier 1 - Quality fixes, highest leverage [I HANDLE]

3. **Cloud temperature bug.** `delegateCloud` never forwards `spec.temperature` to
   the SDK, so all 7 cloud agents run at the SDK default (~1.0) instead of the tuned
   0.2-0.3. Research/analysis agents are far more random and less faithful than
   intended. One code fix, affects every cloud agent. Biggest single quality win.
   (specialists.ts delegateCloud ~1148-1158; verify SDK param name first.)
4. **Memory is stalled, polluted, and thin.** memories table = 20 rows, nothing new
   in 12 days (ingestion starved by a too-high extraction bar); 7 health-check test
   probes are pinned in the 2-slot CORE block at importance 0.95, crowding out real
   facts about Gabe; 5 memories lack embeddings (invisible to search); specialists
   never write memories; async research runs never feed memory. Fix: purge test
   pollution, unstick ingestion (lower the importance floor / soften the skip
   prompt), backfill embeddings, route mission/research outputs through ingestion.
5. **Persona says Tavily, system uses Brave.** Jarvis is told to default to a search
   provider that isn't wired (Brave IS, and works). Misdirects him on his #1 job.
   Reconcile the persona Integrations section to Brave + `/api/web/search`.

## Tier 2 - Make research / analysis / planning top-tier [I HANDLE]

6. **atlas (the planner) self-contradicts.** Its TOOL-DISCIPLINE block ("stop after
   the first result") fights its own "inspect the code before planning" rule, so on
   real planning it under-investigates. Rewrite the block to be task-shaped, and add
   a plan-format contract (GOAL / CONSTRAINTS+ASSUMPTIONS / STEPS with owners /
   RISKS / DONE-CRITERIA). atlas is the most important rewrite for the "plans" goal.
7. **Wire research rigor into sleuth + prism.** Add: corroborate non-trivial claims
   across 2+ independent sources (label single-source), prefer primary/recent
   sources, required output structure (bottom-line -> findings with inline citations
   -> confidence high/med/low -> open questions/gaps), and for prism an explicit
   source-grading scale + overall-confidence + "name the gaps". The good contract
   already exists in `agents/research/CLAUDE.md` but never reaches the specialists.
8. **Shore up oracle (uncensored leg).** It is a 9.6 GB local model reasoning over
   only 5 Brave snippets (240 chars each), and its output ships unflagged. Raise its
   prefetch budget (more results, longer snippets) and/or feed it sleuth's sources.
9. **Rebalance the shared preamble.** ~80% is "EXECUTE, DO NOT DESCRIBE"; add a short
   RIGOR rule (calibrated uncertainty, cite or say unverified, structure first) so
   every agent inherits a quality floor, and gate the tool rules off local agents
   (oracle/heretic/eye have no bash, yet the preamble says they do).
10. **Per-agent polish.** cipher (report n/units/method, no causation from
    correlation, no unsupported patterns); scribe (infer audience/format/length/tone,
    raise local-fallback ctx); coder (run tests/typecheck before "done"); reaper
    (tell it it is the HIGH-risk escalation target); archivist (concrete keep/drop
    threshold).

## Tier 3 - Model muscle where it matters [I HANDLE, Gabe oks cost]

11. **heretic -> cloud Opus** for important runs. The whole bias cross-check rests on
    its discernment and an 8B model is underpowered; its `cloudModel` is already
    Opus 4.8, so it is a one-switch change.
12. **Consider Opus for sleuth and/or prism.** Deep multi-source synthesis and
    contradiction reconciliation are exactly Opus's edge; both are Sonnet now. Cost
    is last per Gabe's stated priorities.

## Tier 4 - Test before trusting it [I HANDLE]

13. **Benchmark each agent** on 2-3 representative real tasks (a research question, a
    data analysis, a writing piece, a plan); score output quality; tune. The Section
    224 run proved the pipeline COMPLETES; this judges whether output is GOOD.
14. **Resolve the dual delegation surfaces.** The native `team` tools and the
    persona's "run `auto` by default" CLI compete; a multi-domain task sent to self
    can be re-collapsed onto one specialist by `auto`. Pick one, align the persona.
15. **Tighten keyword routing.** Substring matches ('log', 'function', 'class ')
    over-trigger and short-circuit the smart router.

## Confirmed healthy (no action)

Service running; Ollama reachable (18 models); both claw binaries present; BRAVE/
DASHBOARD/DB-encryption/Google keys set; honesty-label pipeline intact; recursion
bounded to depth 1; orchestration doctrine excellent; dual-track verified end to end.

## Recommended sequence

1. Gabe supplies Tier 0 (mission + about-him). This is the gate and his stated
   concern; I cannot invent it.
2. In parallel / immediately: I do Tier 1 (temp bug, memory, Brave) - pure wins.
3. Then Tier 2-3 (prompts + model muscle).
4. Then Tier 4 (benchmark + judge + routing cleanup).
5. Only then run real projects.
