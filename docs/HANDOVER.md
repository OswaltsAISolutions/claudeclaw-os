# HANDOVER — master onboarding (READ THIS FIRST, on any PC)

**Purpose:** the single doc a fresh Claude Code session reads to gain full context of the entire ClaudeClaw / Mission Control / Jarvis system and the multi-PC hive mind, on ANY machine, then start working without breaking another session. Last major update: 2026-06-15.

> If you read nothing else: this is a multi-session, **multi-PC** system. You are one of several Claude Code sessions (possibly on different computers) sharing one brain via this git repo. **Pull before you work, register yourself, leave notes, push when you update shared state.** See `HIVE-MIND.md` for the protocol and `SESSION-REGISTRY.md` for who else is live.

---

## 1. The 60-second picture

- **ClaudeClaw / Mission Control / "Jarvis"** is Gabe's personal AI operating system: a persistent service (Telegram bot + web dashboard + a roster of specialist agents) that runs Gabe's research, content, trading, and AI-agency work.
- It lives in **WSL** on the main PC: `/home/gcruise/repos/claudeclaw-os`, service `com.claudeclaw.main.service` (systemd --user), dashboard at **http://127.0.0.1:3141**.
- Multiple Claude Code sessions build and operate it in parallel "lanes." This repo's `docs/` folder is the shared coordination brain.
- Gabe = self-taught AI builder (non-coder), EST. Standing comms style: fewest words, lead with the verdict, no em/en dashes, no hype, be a genuine friend who pushes back (never a yes-man), never fabricate.

## 2. The machines (multi-PC hive mind)

| PC | Role | Notes |
|---|---|---|
| **Main PC** ("game's main PC") | Where everything is built + the live ClaudeClaw service runs (in WSL) | This is the source of truth for the running service + DB. |
| **Desktop 2** | Session lane: "multi PC AI system architecture" | Building the cross-PC architecture. |
| **Gaming laptop** | Being added | Third node. |

All PCs sign into the **same Anthropic / Claude account**, running **separate Claude Code sessions**. They are NOT a shared filesystem. They coordinate through **this git repo** (`github.com/OswaltsAISolutions/claudeclaw-os`, branch `main`), which every PC clones and pulls/pushes. The live service + SQLite DB physically live on the main PC; other PCs reach the *coordination docs* via git and (Phase 2) the *live service* via the network.

## 3. Boot sequence (do this every session, every PC)

1. `git pull` (get the latest brain).
2. Read **this HANDOVER.md**, then **SESSIONS.md** (active lanes + notes), then **SESSION-REGISTRY.md** (who/what is live right now), then your lane's **RESUME-<lane>.md**.
3. Register yourself in `SESSION-REGISTRY.md` (PC, session/lane, status), commit + push.
4. If Gabe typed `resume <lane>`, follow that lane's RESUME next-steps.
5. While working: leave cross-session notes in SESSIONS.md "Notes between sessions"; update your RESUME after every slice; push.
6. Never modify another lane's feature areas/tables. Shared files (db.ts, dashboard.ts, bot.ts, index.ts, App.tsx, etc.) = additive edits only; re-read on conflict; never revert another lane.

## 4. Where everything lives

- **Repo (service code):** WSL `/home/gcruise/repos/claudeclaw-os` (Windows access: `\\wsl.localhost\Ubuntu\home\gcruise\repos\claudeclaw-os`). Git: `OswaltsAISolutions/claudeclaw-os` (origin), branch `main`.
- **Coordination brain:** `docs/` (this folder): HANDOVER, HIVE-MIND, SESSIONS, SESSION-REGISTRY, RESUME-*, BOOTSTRAP, USAGE, incident-runbook, dated handover-*.
- **DB:** `store/claudeclaw.db` (SQLite). Tables incl. memories, hive_mind, clients/client_artifacts, edge_*, content_drafts, usage_ledger.
- **Jarvis persona:** `~/.claudeclaw/CLAUDE.md` (WSL). Edits require Gabe's explicit approval.
- **Per-PC session auto-context:** `C:\Users\GCruise\CLAUDE.md` (on the main PC) auto-loads standing orders into every session and points at the WSL docs. Each other PC needs its own CLAUDE.md pointing at its clone (see HIVE-MIND.md setup).
- **Auto-memory (per machine, NOT auto-synced):** `C:\Users\GCruise\.claude\projects\C--Users-GCruise\memory\` + `MEMORY.md` index. Cross-PC memory sharing is a Phase 2 item; until then the repo `docs/` is the cross-PC source of truth.
- **Agency client docs:** `C:\Users\GCruise\Desktop\Oswalts AI Solutions\` (+ the agency site repo `~/repos/oswalts-ai-site`).
- **Good Nature pitch project:** `C:\Users\GCruise\Desktop\Matt Quarterly\` (current big deliverable, see section 6).

## 5. The lanes + current state (2026-06-15)

- **Agency (Oswalt's AI Solutions):** local-business AI consulting. 80+ leads in the Clients room (`/clients`, `g n`), ~44 deep-dive dossiers done. Deep-dive worker = 4 Sonnet lenses + synthesis; bulk dives use Opus 4.8 heavy legs, max-depth (Good Nature) uses the top model. Outreach tracking shipped. **RUN PAUSED** to preserve weekly usage; resume condition + the 5 hot-lead sequencing are in `RESUME-agency-research.md`. Usage is measured per dive (usage_ledger + USAGE.md).
- **Content Engine:** gate -> Studio -> brief -> verify-before-script fact-check -> script -> Record Mode + Edit Bay (faceless documentary factory). See `RESUME-content.md`.
- **Finance / Edge:** Edge Scanner (pure math, no LLM in scans) + paper trader + arXiv cards, Kalshi-first. Pair-matcher uses `sleuth` (an LLM leg). See `RESUME-finance.md`.
- **Multi-PC AI architecture:** NEW lane (desktop 2). Building the cross-PC hive mind (this handover + HIVE-MIND.md are the foundation).

## 6. CURRENT BIG THING: the Good Nature pitch project

Gabe (Organic Lawn Care Technician at Good Nature, ~$10M organic lawn-care co) is pivoting into AI and pitched to become their in-house AI person. **The Monday 2026-06-15 quarterly went WELL:** COO Matt is escalating to CEO Alec, asked for a proposal package. Package BUILT and in `Desktop\Matt Quarterly\`: "Good Nature - AI Proposal.html" (doc, verified) + "Good Nature - AI Proposal (Deck).pptx" (12 slides) + demo + leave-behind + cheat sheet + pitch v2 (v3 content) + survey prep. GOVERNING RULE for anything GN-facing: **100% accurate, zero BS, no overpromising** (Matt audits a $50 donation; a 1% falsehood sinks it). Full context: memory `client_good_nature.md` + `project_ai_agency.md`. NOT for outside sharing.

## 7. The model situation (IMPORTANT, 2026-06-15)

**Fable 5 went unavailable** ("Claude Fable 5 is currently unavailable"). All Fable-5 roles were moved to **Claude Opus 4.8**: main Jarvis, the router, `sleuth`, `prism`. There is now a single source of truth: **`PRIMARY_MODEL` in `src/config.ts`** (currently `claude-opus-4-8`). To switch everything (when Fable returns OR a better model ships): change `PRIMARY_MODEL` + `PRIMARY_MODEL_DISPLAY` and redeploy. Grep `FABLE5-TEMP` for the temporary spots. Each specialist now self-reports its model (runtimeModelLine). Also: `gemini-2.0-flash` was retired by Google (404) -> upgraded to `gemini-3.5-flash` in `src/gemini.ts`. Full detail: memory `project_fable5_upgrade.md`.

## 8. Hard rules (do not violate)

- **Gate before build:** full `npx tsc --noEmit` + `npx tsc -p web/tsconfig.json` + `npx vitest run` must pass BEFORE `npm run build` (a build compiles every lane). Use `/tmp/agency-gate2.sh` (exit-code-aware; the old agency-gate.sh masked vitest failures by piping to tail).
- **Additive schema only.** Never alter/drop another lane's tables/columns.
- **Log restarts** in SESSIONS.md before restarting; a restart bounces every lane ~30s.
- **Never without explicit approval:** PC restart, plugin install, permission/OAuth changes, `.env` edits, Jarvis-persona edits.
- **No mock data** (show pending/disconnected honestly). **Never fabricate** (especially anything client-facing).
- After a marathon / ~3 shipped slices, update RESUME + tell Gabe it's a good fresh-session stopping point.

## 9. Gotchas (hard-won)

- **wsl.exe mangles nested quotes/$()/pipes:** write a script to a file and run `wsl -- bash /tmp/x.sh`. Don't call wsl from the Git Bash tool (MSYS rewrites /home paths).
- **PowerShell + native exe stderr** under Stop-mode: wrap noisy exes in `cmd /c "... 2>nul"`.
- **iOS Mail attachment preview blocks JavaScript:** HTML deliverables for phone must work with pure CSS (see the GN demo, which auto-plays via CSS).
- **HTML docs need an explicit `background:#fff`** or they're unreadable in dark mode.
- **No LibreOffice on the main PC:** can't render .pptx -> images for visual QA here.

## 10. Active obligations / next-ups

- Agency dive run resumes after the weekly cap reset + Gabe's go (5 hot leads queued first; see RESUME-agency-research.md).
- Good Nature: Gabe confirms cert specifics + has his Anthropic credential link ready before sending the package; Phase-2 tech-stack mapping waits on Matt granting office access.
- Multi-PC hive mind: build out per HIVE-MIND.md (Phase 2 = live cross-PC via the networked service).
- Switch models back to Fable 5 the moment it returns (one-edit: PRIMARY_MODEL).
