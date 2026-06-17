# Handover 2026-06-10: Money Systems slice (Edge Scanner + arXiv papers)

Gabe shared three X posts ("I want both of these systems in order to start making money"):
an open-source quant terminal (QuantMind) and a Polymarket "Citadel quant up $430k" copytrade
promo plus a "$40M arbitrage math" article. A 5-agent research workflow (wf_2d1beb6c-a9b,
full reports in the session task output) produced the verdicts that shaped this slice.

## Research verdicts (do not relitigate without new evidence)

- **Copytrade post = referral bait.** Wallet 0xb55fa129...64d4 is real ($441k PnL on
  Polymarket's own APIs) but it is a latency-arb HFT bot: $39.7M volume in 41 days,
  ~22 trades/min on 5/15-min crypto up/down markets, 1.11% edge per dollar. @0x_Discover
  is a serial referral farmer (4 near-identical promos since Jan 2026, same Kreo ref code).
  Copying via KreoPolyBot is -2.5% to -5.5% EV per trade at ~14x daily turnover. NEVER deposit.
- **The $40M arb is real but historical** (IMDEA paper arXiv:2508.03474, Apr 2024-Apr 2025,
  zero-fee era). Taker fees (Jan-Mar 2026) + bot saturation killed retail speed arb.
  Verified solo benchmark: $2.5k/mo peak decaying to $390/mo in 3 months.
- **Ohio blocks Polymarket US** (with AZ/IL/MA/MD/MI/MT/NV); global Polymarket geo-blocks
  all US at the API level; VPN = ToS/CFTC violation, categorically out. **Kalshi is the only
  venue legally tradable from Ohio** (free API, sanctioned bots, demo sandbox), but it is at
  war with Ohio over SPORTS contracts ($5M fine Apr 2026): avoid sports, prefer econ/weather/
  crypto/politics markets.
- **quant-mind (LLMQuant) is broken on master** (PR #79: paper_flow cannot complete; no
  storage layer; welded to OpenAI Agents SDK). Cloned at ~/repos/quant-mind, watch monthly.
  The useful sibling is LLMQuant/data-mcp (hosted MCP: SEC, 13F, FRED, prices, quant wiki);
  needs Gabe to sign up at llmquantdata.com for LLMQUANT_API_KEY.

## What shipped this slice (all deployed, tests 1022 pass)

### System 1: Edge Scanner (read-only, no keys, no orders)
- `src/edge-scanner.ts`: 5-min sweeps of Kalshi public API (events+nested markets,
  sports excluded) + Polymarket gamma (top 500 events by 24h volume). Detects:
  negRisk buy-all-YES / buy-all-NO deviations, Kalshi YES+NO<\$1, wide Kalshi spreads
  (maker candidates), and Kalshi-vs-Polymarket dislocations on matched pairs.
  Pair matching: Jaccard title heuristic -> scribe LLM batch confirmation (same/inverse/
  different, conf>=0.7). Fee models documented in-file (Kalshi ceil(0.07·p·(1-p));
  Poly 0.072·p·(1-p) where feesEnabled). Opportunities have open/close lifecycle ->
  first_seen/closed_at IS the duration dataset for the go/no-go gate.
- `src/db.ts`: edge_pairs, edge_opportunities, edge_stats tables + CRUD.
- `src/dashboard.ts`: /api/edge/{summary,opportunities,pairs,stats,scan} + PATCH pairs/:id.
- `web/src/pages/Edge.tsx` at /edge ("Edge Scanner", hub section, `g d`, Radar icon):
  worker state strip, stat chips, Open/History/Pairs tabs, confirm/reject pair buttons,
  honest footer (depth unknown in v1, fee model stated, nothing funded).
- Telegram alerts via setEdgeNotifier in bot.ts: net edge >= 3% after fees, 30-min cooldown,
  sports excluded, message states "measurement only, nothing is funded".

### System 2: arXiv papers in the Content Library
- `src/library-shared.ts`: arxiv.org/abs|pdf URLs canonicalize to /abs/<id>, platform 'arxiv'
  (bot share-to-Jarvis and dashboard paste both work automatically).
- `src/library-worker.ts` processArxivItem: arXiv Atom API meta -> PDF download ->
  PyMuPDF text extraction (scripts/pdf_extract.py, media venv; pymupdf installed) ->
  regular categorizer -> scribe "paper card" (method/asset_class/alpha_claim/data/
  limitations/replication_difficulty/practical_use) merged into analysis.paper_card.
- `web/src/pages/Library.tsx`: "Papers" platform tab, arXiv badge, PDF icon + Open-PDF
  button, Paper-card section in the drawer.
- First two papers ingested: 2508.03474 (IMDEA arb paper) and 2509.21507 (QuantMind).

### Watchers (schedule CLI)
- be14d734: weekly Mon 9am regulatory sweep (Ohio on Polymarket US? Kalshi v. OCCC?
  Ohio bill? CFTC preemption?) -> Telegram.
- Monthly 1st 10am: quant-mind PRs #77/#79 + storage layer; flag when usable.

## Go/no-go gate (week of ~2026-07-08, after 2-4 weeks of scanner data)
Fund $500 max on Kalshi ONLY if: (1) scanner shows post-fee edges at measurable
frequency/duration, (2) a Kalshi demo-sandbox maker bot (NOT YET BUILT, next slice)
executes cleanly, (3) Ohio user-level legal exposure for non-sports contracts checks out.
Until then: zero capital, paper only. Gabe must open the Kalshi account himself (KYC).

## Keys (wired same evening, Gabe-approved)
- Kalshi: key id + PEM path in .env, PEM at ~/.claudeclaw/keys/kalshi.pem (0600).
  Verified live (signed balance call -> 200, $10.00 signup balance). RSA-PSS sample
  in /tmp/test_kalshi_only.js. ROTATE the key before funding (it transited chat).
- LLMQuant: LLMQUANT_API_KEY in .env (verified 200); llmquant-data MCP server added
  to WSL ~/.claude/settings.json so Jarvis main has SEC/13F/FRED/quant-wiki tools.
- config.ts: all three keys in the readEnvFile allowlist + exported consts.

## Paper trader (SHIPPED same night, second slice)
- `src/edge-paper.ts` + edge_paper_trades table + /api/edge/paper + "Paper book" tab in
  /edge + Telegram on every simulated open/close. Fake $500, $50/position, 6 max open,
  one per market, entry bar = 3% net (same as alerts). Strategies: xvenue (buy the cheap
  Kalshi side vs Poly fair value) + kalshi_intra (YES+NO<$1 pairs held to settlement).
  Exits: convergence (sell when the gap closes, round-trip fees modeled) or settlement
  ($1/contract winner, no fee). Attribution per kacho lesson: edge_captured at entry vs
  directional residual; if residual drives P&L, it's betting, not arb, and the gate review
  must say so. NEVER calls an order endpoint (GETs only, grep-verified by review agents).
- Adversarial 9-agent review BEFORE deploy confirmed + fixed: (1) CRITICAL voided-market
  trades stuck open forever (now: terminal non-yes/no result -> close flat, refund model);
  (2) arb positions marked with YES mid vs combined-pair entry (now: arb mark = yesMid+noMid);
  (3) silent 20-page Kalshi pagination cap (now: 30 pages, partial-sweep flag in state+UI,
  kalshi-kind lifecycle closes suspended on partial sweeps, truncated-out held positions
  get single-market quotes so marking/convergence still work, alert cooldown now survives
  close/reopen row flaps via lastEdgeAlertTs). Two findings refuted by verification agents.

## Known gaps / next slice
- Research-brain layer on the paper trader (FRED/SEC/13F via llmquant-data MCP informing
  which side of a dislocation is wrong), per Gabe's "one system" direction.
- Maker-side simulation (resting quotes + fill model) once taker-side data accumulates.
- Edge depth is unknown (no order-book fetch in v1); add book sampling for the top
  opportunities if the dataset looks promising.
- data-mcp integration blocked on Gabe's llmquantdata.com signup.
- A parallel session was building Content Studio (/studio, `g t`) at the same time;
  both features coexist, tree was left uncommitted on main per existing practice.
- The wallet-forensics teardown is camera-ready GCruise content (all receipts are
  public API calls; see the workflow forensics report).
