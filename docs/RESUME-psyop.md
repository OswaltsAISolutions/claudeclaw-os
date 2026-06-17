# RESUME: Psyop Scoring lane (NCI Engineered Reality Scoring System)

**Opened 2026-06-13 by the Content session at Gabe's request. BUILT + DEPLOYED +
VERIFIED 2026-06-13 ~19:05 UTC. Read this + docs/SESSIONS.md first.**

## STATUS: shipped and live

Built per the spec below, gate green (tsc x2, 1022 tests), deployed (worker idle,
clean restart). E2E verified twice on the Nayirah-incubator case (the video's own
example): local gemma-4-abliterated drafts -> opus-4.8 verifies -> 67/100 "strong",
all 20 items with grounded evidence, mid-range "truth-with-an-agenda" note fired.
Post-build fix: an evidence guard in normalizeItems() rejects filler/"placeholder"
evidence (model-independent) + the prompt forbids it — caught a real "placeholder"
leak on the first run. Two test rows were created then deleted; room starts empty.

How Gabe uses it: the **Psyop Score** room (/psyop, shortcut **g x**) — paste a
subject + the material, hit Run; or ask Jarvis ("score this for psyop") which calls
the `score_psyop` team tool. Both share the same backend and persist to the room.

Files shipped: src/psyop-scorer.ts, psyop_scores table + helpers (db.ts),
/api/psyop/* (dashboard.ts), score_psyop tool (team-tools.ts), web PsyopScoring.tsx
+ routes.ts/App.tsx entries. Usage logged under scope 'psyop' in usage_ledger.

Possible polish later (not blocking): per-item local-vs-cloud disagreement view;
URL-paste that auto-fetches article text server-side (currently paste-the-text);
a "re-score" button; surface the score in the content gate as an optional signal.

---

## (original spec, for reference)

## What Gabe wants

A way to have Jarvis score "certain things" (claims, articles, headlines, events)
against Chase Hughes' **NCI Engineered Reality Scoring System** to gauge how
probably they're a psyop. Decisions he made (AskUserQuestion 2026-06-13):
- **Surface = a dedicated Mission Control room** ("Psyop Scoring").
- **Model = local-first, cloud-verify**: local abliterated model runs the 20-item
  score (free, uncensored, won't refuse to call a govt/corp narrative a psyop),
  cloud (Opus 4.8 — Fable is temporarily out, see FABLE5-TEMP) sanity-checks it.
- Original ask also says "have jarvis score them," so ALSO expose a Jarvis tool
  that calls the same backend (room + tool share one scorer).

## Already done (durable, do NOT redo)

- `docs/psyop-nci/NCI-SCORING-SYSTEM.md` — the 20 categories VERBATIM from the
  official instrument (PSYOPS Identification Tool V8.3, © Applied Behavior
  Research 2024), with questions, examples, scoring (1-5), and official bands.
  THIS is the data the scorer encodes. Use it as the source of truth.
- `docs/psyop-nci/nci-psyops-identification-tool-v8.3.pdf` — the original.
- `docs/psyop-nci/the-why-files-617-transcript.txt` — the video transcript.
- Auto-memory `reference_nci_psyop_scoring.md` — hive-mind pointer.

## Build spec (turnkey)

### Backend
1. **`src/psyop-scorer.ts`** (new):
   - `NCI_CATEGORIES`: typed const of the 20 items (id, category, question,
     example) copied from NCI-SCORING-SYSTEM.md.
   - `scorePsyop({ subject, text, sourceUrl? }, opts)`:
     a. LOCAL score: `delegate('oracle', prompt, { shareMemory:false })` (gemma-4
        abliterated; heretic = neuraldaredevil as fallback). Prompt demands a
        JSON array of 20 objects {id, score 1-5, evidence: one line tied to the
        input}. No vibes — every score needs a concrete observation or it's a 1.
     b. CLOUD verify: reuse the per-call model override the Agency session added
        to `DelegateOptions` on 2026-06-12 — `delegate('prism', verifyPrompt,
        { model: 'claude-opus-4-8', shareMemory:false })`. Feed it the input +
        the local 20-item draft; it confirms/adjusts each score with reasons and
        returns the final 20-item array.
     c. Compute total (sum, 20-100) + band from the OFFICIAL bands (0-25 low /
        26-50 moderate / 51-75 strong / 76-100 overwhelming). Add the
        "truth-with-an-agenda" caveat note when total lands ~40-75.
     d. Return { subject, items[20], total, band, localModel, verifyModel,
        disclaimer }. Disclaimer = "scores manipulation FORM, not truth."
   - `extractJson` helper (mirror edit-director.ts / edit-vision.ts: last
     brace-balanced block wins; abliterated models echo prompts).
2. **`db.ts`** (SHARED, additive only): `psyop_scores` table (id, subject,
   input_text, source_url, local_json, verify_json, final_json, total INTEGER,
   band TEXT, model_local, model_verify, created_at) + create/get/list/delete
   helpers. Log burn via `recordLegUsage('psyop', id, leg, delegateResult)` —
   the usage_ledger scope is generic, no schema change needed.
3. **`dashboard.ts`** (SHARED, additive): POST /api/psyop/score (body: subject +
   text, or url -> fetch via web-search.ts/WebFetch then score), GET
   /api/psyop/scores (list), GET /api/psyop/scores/:id, DELETE /api/psyop/scores/:id.
   Scoring is fire-and-forget like dives (local pass ~secs, cloud verify ~10-20s);
   row carries a status field or write synchronously if fast enough.
4. **Jarvis tool**: add `score_psyop(subject, text)` to the in-process team tools
   (see project_native_orchestration: delegate/team_roster live in the main bot);
   it calls scorePsyop and returns a compact summary so Gabe can ask in Telegram
   or dashboard chat.

### Frontend
5. **`web/src/pages/PsyopScoring.tsx`** (new): subject + text/URL input, Score
   button, result card (20-item breakdown with a 1-5 bar each + evidence line,
   big total + band badge, the form-not-truth disclaimer), scored-history list.
   Visual taste: Factorio-room-in-iOS-skin, glass surfaces, real data only.
6. **`web/src/lib/routes.ts`** (SHARED, additive): add the route.
7. **`web/src/App.tsx`** (SHARED, additive): nav entry + keyboard shortcut **g x**
   (claimed below; x = x-ray/detection).

### Gate + deploy
8. Full `npx tsc --noEmit` + `npx tsc -p web/tsconfig.json` + `vitest run` BEFORE
   build (use /tmp/agency-gate2.sh pattern — exit-code-aware). Log the restart in
   SESSIONS.md BEFORE restarting. Dive worker is idle as of 2026-06-13, so a
   restart is currently a free ~30s blink, but re-check the board first.

## Standing rules
- The 20 items are FIXED (official instrument) — never invent or "improve" them.
- It's a manipulation-FORM detector, not a truth detector. Every result must say so.
- Keep it cap-cheap: local does the heavy lifting (free); cloud verify is one
  small Opus 4.8 call. Don't route the whole thing to cloud.
- Shared-file rules (db.ts, dashboard.ts, App.tsx, routes.ts, bot.ts): additive
  only, re-read on conflict, never revert another lane.

## Related state
- Uncensored local model topology: auto-memory `project_research_team`.
- Do NOT confuse with the content fact-checker (`src/fact-checker.ts`): that
  verifies claim TRUTH; NCI scores manipulation SHAPE. Different jobs, can coexist.
