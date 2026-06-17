# RESUME: Agency deep-dive research run

**Saved 2026-06-12 ~20:45 EST (session 3). Read this first in a new session, then pick up at "What to do next".**

## Session-3 work (2026-06-12 evening)

- **Dive model-routing SHIPPED ~20:52 (Gabe directive):** standard bulk dives run prism-synthesis + sleuth-pitch-research legs on claude-opus-4-8 (half Fable 5 cost); DelegateOptions gained a cloud-only per-call `model` override (specialists.ts, additive, NO global config changes). Good Nature always full-power Fable 5; POST /api/clients/:id/deepdive accepts {"depth":"max"} for future max-depth dives (flag survives cap-crash requeues). 44 paused dives benefit on resume.
- **GN EXTREME DEEP DIVE in progress:** deep-research workflow (run wf_e490b0d9-246) fanning out on 7 external lenses; pitch v2 + KB intel loaded; dossier (deep_dive artifact on the GN card, full Fable legs unaffected by the routing change) + extreme addendum doc to follow.

- **Storefront slice DONE (step 3 a+b+c):** (a) site V2 refresh in ~/repos/oswalts-ai-site (5 award-style service rows now mirror the 4 packages: instant-quote sites, AI answering, review engine, Google setup-only "hand you the keys", THE FULL OVERHAUL flagship row w/ accent gradient + FLAGSHIP pill; hero/marquee/meta-description updated; NO draft prices published, numbers stay Gabe's). Testimonial section #results built + styled but `hidden` with [REAL ...] placeholder slots (no invented quotes; enable = paste real quotes, drop `hidden`, add nav pill; site-only rule annotated in the HTML comment). Verified in preview (snapshot + screenshot, zero console errors); Desktop\Oswalts-AI-Website\index.html synced. (b+c) **`Desktop\Oswalts AI Solutions\Go Live Runbook.html`** = Gabe's ~30-min walkthrough: Cloudflare account -> buy oswaltsai.com (~$11, RE-VERIFIED available via RDAP 2026-06-12 evening, oswaltai.com backup also free) -> Pages direct-upload deploy -> custom domain -> Email Routing gabe@ -> Gmail send-as w/ app password + done-checklist. Outreach starts only after he completes it and says go.
- **Outreach tracking SHIPPED + e2e verified** (step 5 / step 3d): additive clients columns `contacted_at` / `replied_at` / `last_touch_at` / `next_touch_at`; touch history = client_artifacts kind='outreach' (excluded from doc export + generic artifacts list); `POST /api/clients/:id/touch` `{direction:'out'|'reply', channel?, note?, next_touch_at?}` (out: sets contacted_at once + auto-bumps stage lead->contacted; reply: sets replied_at, no stage bump); Clients UI: Outreach panel in drawer (log buttons + channel/note + next follow-up date + history), card status line (contacted/replied/awaiting + follow-up due chip, amber when due/overdue), amber "Follow-ups due (N)" filter chip sorted oldest-due-first. Deployed ~20:40 (run paused, zero cost; tally 37/44 unchanged). Verified live with a throwaway client, then deleted it.

## Where things stand

- **Client pipeline:** 80 companies in the Clients tab (`/clients`, shortcut `g n`) and mirrored as folders at `C:\Users\GCruise\Desktop\Oswalts AI Solutions\Clients\<Company>\`.
- **Deep-dive v2 dossiers DONE: 13 ready, 0 failed.** B & B Roofing (the cap casualty from 2026-06-11 23:25) re-ran as the canary and landed ready at 11:33.
- **RUN PAUSED BY GABE 2026-06-12 ~18:25 (to preserve weekly usage): CONFIRMED idle ~18:50: exactly 37 dossiers ready, 44 paused, 0 failed, worker idle (zero tokens burning).** Last dossier in = Clean Expressions Home & Office Cleaning (fixables verified). He is PIVOTING to our-side setup (website/storefront: HE raised it, the parking is lifted) and will personally reach out to the finished batch. Resume the rest ONLY after our side is done and he says go: flip paused->queued (`/tmp/agency-resume-all.sql`).
- Run history: pace settled ~17 min/company after two mid-run deploys (12:32 internal_ops 3200; 15:36 boundary deploy: reputation 3000 + internal_ops 4000 + tail-logging). Residual ~1-in-9 "unparseable, retrying" = mercury occasionally answering in prose instead of JSON (tail diag proved it; NOT truncation); the built-in retry recovers it, no further fix needed. Boundary-deploy pattern: /tmp/agency-boundary-deploy.sh waits for ready-count++ then restarts in the ~20s gap, zero in-flight loss.
- Each finished dossier = 4 Sonnet lenses (website/ads, reputation, social, internal-ops) + Fable synthesis, exported to the company folder as `Deep Dive.html` and visible via "View brief" in the client drawer.
- **Session-2 work so far (2026-06-12 morning):**
  - **Pricing packages DRAFT written** (step 4): `Desktop\Oswalts AI Solutions\Pricing Packages DRAFT.html`. 3 packages priced from the dossier lead-pattern (instant quote+booking $5k/$250mo, AI answering $3k/$500mo, review engine $1.5k/$300mo) + setup-only ads add-on + bundle. ALL prices are drafts for Gabe.
  - **Windows trailing-dot folder bug FIXED in code** (clients-export.ts `clientFolderName` now strips trailing `.`/space; folders like "Best Courier, Inc." were unopenable from Explorer). The 6 broken folders already renamed on disk via WSL.
  - **Worker cap-crash guard added** (clients-research.ts): bare "exited with code N" failures now requeue with 60-min nap, max 3 tries, instead of fast-failing; without this, a mid-run cap-hit would torch the whole queued backlog into `failed` in minutes.
  - Code changes gate-checked green (tsc x2 + 1022 vitest); deploy (build+restart) pending the canary verdict, BEFORE unleashing the 68.
  - **~11:58 deploy: fixable-problems dive upgrade** (Gabe directive): internal_ops lens hunts buggy/subscription software + manual quoting + routing waste + disconnected tools; synthesis emits `fixable_problems[]`; exporter + drawer render "Fixable problems we found"; offer text includes custom apps/CRMs/integration/full overhauls.
  - **~15:1x boundary deploy (auto-fires when in-flight dive lands):** retry rate hit 3-in-6 dives, so reputation lens 2200->3000 + brevity guard, internal_ops 3200->4000, unparseable log now prints the output tail. Deployed via /tmp/agency-boundary-deploy.sh (waits for ready-count to tick up, restarts in the ~20s gap, zero in-flight loss): reusable pattern for any future mid-run deploy.
  - **~12:32 hotfix deploy:** the new lens JSON truncated at maxTokens 2200 (unparseable -> retry; Rescue Roofing ran 30+ min vs 6-9 norm). internal_ops lens now 3200 tokens + brevity guard; synthesis 4600. If future dives run way over ~10 min, check journalctl for "unparseable ... retrying" first.

## QUEUE SEQUENCING (Gabe directive 2026-06-12 evening, BINDING)

1. ~~GN extreme dive~~ DONE 2026-06-12 ~21:52 (artifact 05ebcc97-d3cc-4b64-8f3b-f4399093cdef): ready + EXTENDED (worker dossier + insider/KB fixables via /tmp/gn-extend.mjs => 7 opportunities, 21 fixables, 9 signals, 6 competitors, 30 sources) + exported (Deep Dive.html regenerated, NEW "Extreme Dive Addendum.html" in the GN folder = new-vs-pitch-v2 finds, provenance benchmarks, competitor matrix, 7-phase roadmap). Measured burn: 257.2k in / 23.8k out, 22.7 min, 0 retries (weighted ~14.7k). Headline NEW finds: RGM 1.5/5 80 App-Store ratings + daily reinstalls (public proof of the insider complaint), go.whygoodnature.com/online-quote 404s, Glassdoor 20-30 handwritten notes/tech/day (30-60 min), CER posting = manual office-field relay + personal handwritten call logs, BBB Oct-2024 refund-never-delivered, invisible on "lawn care Cleveland OH" SERP, organic social dead since Sept 2025, site lists 8 markets (adds Akron + Ann Arbor), Alec publicly on SweetProcess case study ("chasing my tail, fighting fires"), DIY e-commerce arm (diyorganiclawncare.com). The "which service tomorrow?" confusion is NOT in public reviews yet: untapped differentiator, frame from firsthand + Alec's words only.
2. ~~EXACTLY 5 more dives~~ DONE 2026-06-13 ~early UTC, all 5 ready, 0 failed, 0 retries: Challengers Tree (69d5ac44), Clary Trucking (752eb1ef), Euro Trucking (5c6e9555), J.B. Express/Bell Logistics (59e7b946), Rainbow Express Courier (b90ac0a8). Measured 5-dive burn: 2.75M in / 98.7k out, weighted 37.4k (under the ~45k projection). Worker now IDLE (39 still paused). Levers: pause = `/tmp/agency-pause-queued.sql`, resume-all = `/tmp/agency-resume-all.sql`.
2b. **75% WEEKLY-USAGE GUARDRAIL (Gabe 2026-06-13): pause where you're at if usage reaches 75% of his weekly Max cap.** HONEST LIMITATION: nothing in this repo reads the Anthropic weekly-cap %; that number is only in Gabe's Claude UI (rate-tracker.ts is in-memory per-min/hour/day, not weekly-cap-aware). So there is NO automated 75% trip. The REAL automated protections: (i) only 5 dives are queued, so the worker self-idles after them regardless; (ii) the worker hard-pauses the whole queue on any Anthropic usage-limit signal (the 100% wall). For the literal 75% line, Gabe watches his UI and triggers the pause lever, or a session reports measured burn (docs/USAGE.md, usage_ledger) so he can call it. Do NOT fabricate a % from inside the system. If a future session needs a real auto-75% stop, it requires Gabe's absolute weekly cap (in tokens) as input; he has not provided it.

3. **Everything else (remaining ~39 paused) STAYS PAUSED until the next weekly cap reset.** RESUME CONDITION for a future session: after the weekly usage reset lands (resets have been landing Friday mornings EST; cap burned ~50% by morning of Thu 2026-06-12), confirm headroom with Gabe, then flip paused->queued via `/tmp/agency-resume-all.sql` (recreate from the note below if /tmp got wiped). Do NOT flip early; do NOT re-decide the sequencing.
4. Per-dive burn is now MEASURED: usage_ledger table + docs/USAGE.md + burn line on dive cards. After GN + the 5, the budget call for the rest of the week is made from real numbers (SESSIONS.md note posts GN burn + 5-dive projection).

## How to RESUME the run (one command, only needed if someone re-pauses it)

```bash
wsl -d Ubuntu -- sqlite3 /home/gcruise/repos/claudeclaw-os/store/claudeclaw.db ".read /tmp/agency-resume-all.sql"
```

(`/tmp/agency-resume-all.sql` holds the paused->queued UPDATE; if it's gone, recreate: `UPDATE client_artifacts SET content = replace(content, '"status":"paused"', '"status":"queued"') WHERE kind='deep_dive' AND content LIKE '%"status":"paused"%';` NOTE: passing SQL with nested quotes through wsl.exe inline gets mangled; write it to a file and `.read` it.)

The worker (src/clients-research.ts, runs inside com.claudeclaw.main.service) polls every 20s and resumes automatically: no restart needed. It self-pauses if it hits a usage limit (requeues the job + naps 60 min). As of the 2026-06-12 ~11:34 deploy it ALSO requeues bare "exited with code N" subprocess deaths (the signature of the cap killing a run mid-flight), max 3 tries per job, so a cap-hit can no longer burn the queue into `failed`.

## Status checks

```bash
# tally: ready / paused / queued / running / failed
wsl -d Ubuntu -- sqlite3 /home/gcruise/repos/claudeclaw-os/store/claudeclaw.db \
  "SELECT CASE WHEN content LIKE '%\"status\":\"ready\"%' THEN 'ready' WHEN content LIKE '%\"status\":\"paused\"%' THEN 'paused' WHEN content LIKE '%\"status\":\"queued\"%' THEN 'queued' WHEN content LIKE '%\"status\":\"running\"%' THEN 'running' ELSE 'failed' END st, COUNT(*) FROM client_artifacts WHERE kind='deep_dive' GROUP BY st;"
```

## What to do next (in order)

1. ~~Resume the run~~ DONE 2026-06-12 ~11:35: 68 queued, grinding. UPGRADED ~11:58 (see below); Gabe's order: **complete the ENTIRE list**, then review together.
2. **When the queue empties (expect evening of 2026-06-12):** quality-sweep: spot-check 3-4 dossiers across niches (confirm the new "Fixable problems" section is populating), re-run any `failed` ones (POST `/api/clients/:id/deepdive`), confirm every company folder has its `Deep Dive.html`. Status tally: `wsl -d Ubuntu -- sqlite3 /home/gcruise/repos/claudeclaw-os/store/claudeclaw.db ".read /tmp/agency-tally.sql"`. Consider re-running the EARLY 13 dossiers (pre-upgrade, no fixable_problems section) so the whole list is consistent: ask Gabe at review time, do not burn allowance unprompted.
3. **Storefront step: BUILD SIDE DONE 2026-06-12 evening (session 3); now waiting on GABE.** (a) site V2 packages refresh DONE; (b)+(c) Go Live Runbook.html DONE (his ~30-min part: buy domain, upload site, email setup); (d) outreach tracking DONE. **Remaining storefront items that need GABE:** complete the runbook checklist; hand over the 2 real testimonials (then: paste into the hidden #results section, remove `hidden`, add nav pill, re-upload). After site is live: switch the site contact email from the Gmail address to gabe@oswaltsai.com.
4. ~~Pricing packages draft~~ DONE 2026-06-12, v2: `Desktop\Oswalts AI Solutions\Pricing Packages DRAFT.html`. Now FOUR packages: instant quote+booking $5k/$250mo, AI answering $3k/$500mo, review engine $1.5k/$300mo, **Package 4 Internal AI Overhaul (Gabe directive: the flagship)** = automatic quoting, route optimization, custom apps/CRMs, fix-or-replace buggy subscription software, system integration, full overhauls; scoped per project ($1.5k discovery audit credited, $2.5k-7.5k targeted fix, $7.5k-20k custom app/CRM, $20k+ full overhaul, $500-1.5k/mo support). Plus ads setup-only $1k, bundle $8.5k/$950mo. Gabe LIKES the pricing; numbers still his to finalize.
5. ~~Outreach tracking~~ DONE 2026-06-12 ~20:40 (see Session-3 work above). NO outreach happens until Gabe green-lights.

## Standing rules (do not violate)

- ZERO outreach to anyone until Gabe green-lights.
- **DO NOT bring up the storefront/domain/email/his-end setup to Gabe until HE raises it (his order, 2026-06-12).** Finish the whole list, review, then he triggers it.
- NEVER mention testimonials/social proof in pitches; full-price posture; ads = setup-only.
- **Every dive/pitch/report is optimized for THAT company's specific needs from what the dive found; fixable problems (bugs, inefficiencies, subscription pain) are ALWAYS surfaced so Gabe sees them (his order, 2026-06-12). The offer is the full stack: anything AI can do for a business, including complete internal overhauls, custom apps/CRMs, auto-quoting, route optimization, system integration.**
- **Token + re-run latitude (Gabe 2026-06-12): dives may use as many tokens as they need (raise caps without asking), and a subpar dossier may be re-run (POST `/api/clients/:id/deepdive`). Both ONLY when needed: no blanket re-runs.**
- Service-texts demo is Good Nature-ONLY (its card in /clients).
- Good Nature gets NO automated dive (bespoke pitch v2 exists on Desktop).
- Concurrent-session rules in docs/SESSIONS.md (additive schema, typecheck before build, log restarts).

## Related state (other lanes, FYI)

- Edge Scanner + paper trader: autonomous, no LLM in scans; paper book accumulating toward the ~Jul 8 funding gate.
- Weekly regulatory watcher Mon 9am; monthly quant-repo check; nightly 2am recap.
- Full agency context: auto-memory `project_ai_agency.md`; client intel: `client_good_nature.md`.
