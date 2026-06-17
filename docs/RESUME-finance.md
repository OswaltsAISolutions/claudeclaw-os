# RESUME: Finance lane (Edge Scanner + paper trading)

**Saved 2026-06-11 ~23:20 EST. This lane is FULLY AUTONOMOUS: nothing to resume
unless something broke or the gate date arrives.**

## Live state

- **Edge Scanner**: 5-min sweeps of Kalshi (~26k markets) + Polymarket gamma (top 500 events), zero LLM in scans. Pair-matcher (sleuth/Fable) verifies new cross-venue pairs ~every 30 min in small batches. `/edge` tab (`g d`).
- **Paper trader**: fake $500 book, $50/position, 6 max open, entries 3-15% net after fees, price band 5-95c, poly fair value only on tight books. Positions resolve by convergence or settlement; voided markets refund flat; usage-limit-proof. Telegram per open/close.
- **Data being collected**: opportunity open/close durations + paper P&L with edge-vs-residual attribution = the evidence for the funding gate.

## The gate (~Jul 8, 2026; 4 weeks from 2026-06-10 start)

Fund $500 real (Gabe's decision, his ACH) ONLY if ALL three pass:
1. Scanner data shows post-fee edges at real frequency/duration (not seconds-scale flaps).
2. Paper P&L is positive and DRIVEN BY edge_captured, not directional residual (if residual dominates, it's betting, not arb: say so plainly).
3. Ohio legal check for non-sports Kalshi contracts still clean (weekly Mon 9am watcher reports).

## Keys / accounts

- Kalshi: key id + PEM at ~/.claudeclaw/keys/kalshi.pem (rotated 2026-06-10, old key verified dead). $10 signup balance. ROTATE AGAIN before real funding.
- LLMQuant data MCP wired into Jarvis (llmquant-data in WSL ~/.claude/settings.json).
- Polymarket: NOT tradable from Ohio (geo-blocked); data feed only. If the Monday watcher reports Ohio opening on Polymarket US, the two-leg arb becomes possible: scanner already computes the spreads.

## Next steps when picked up

1. Check paper book + scanner health: `bash /tmp/status_check.sh` in WSL (or /api/edge/summary + /api/edge/paper).
2. Mid-June: glance at edge_opportunities duration stats; flag if everything closes in <10 min (bad sign for the gate).
3. ~Jul 8: write the gate review (scanner data + paper attribution + legal) and give Gabe the go/no-go recommendation.
4. Backlog (only if data justifies): order-book depth sampling for top opportunities; maker-side fill simulation; research-brain layer (FRED/SEC via llmquant-data informing entries).

## Standing rules

- NEVER fund/trade real money without Gabe's explicit go at the gate.
- Never deposit into promoted wallets/copytrade bots (the Kreo lesson, receipts in memory).
- Sports markets: excluded everywhere (Ohio enforcement).
- Full context: memory `project_money_systems_2026_06_10.md` + `project_fable5_upgrade.md`; repo docs/handover-2026-06-10-money-systems.md.
