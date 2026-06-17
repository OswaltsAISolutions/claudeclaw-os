# USAGE.md — measured cloud burn (auto-written by src/usage-ledger.ts)

Source of truth: usage_ledger table in store/claudeclaw.db (per-leg rows).
tokens_in includes cache writes + reads (full context processed). "weighted"
= tokens_out x model cost weight (fable-5 = 1.0, opus 0.5, sonnet 0.3).

**Rolling 7-day total: 3004k in / 123k out (weighted ~52.1k fable-equiv) across 6 jobs / 30 legs.** Updated 6/12/2026, 11:51:46 PM EST.

## Log (newest first)
- 06/12, 23:51 deep_dive Clary Trucking, Inc. — 504k in / 15.6k out (weighted 6.1k), 5 legs, 17.4 min, 0 retries [sonnet-4-6 + opus-4-8]
- 06/12, 23:34 deep_dive Challengers Tree Service — 1290k in / 34.3k out (weighted 12.4k), 5 legs, 19.8 min, 0 retries [sonnet-4-6 + opus-4-8]
- 06/12, 23:13 deep_dive J.B. Express, Inc. (with Bell Logistics Co.) — 460k in / 16.9k out (weighted 6.6k), 5 legs, 23.9 min, 0 retries [sonnet-4-6 + opus-4-8]
- 06/12, 22:49 deep_dive Euro Trucking, Inc. — 234k in / 16.0k out (weighted 6.2k), 5 legs, 20.0 min, 0 retries [sonnet-4-6 + opus-4-8]
- 06/12, 22:29 deep_dive Rainbow Express Courier Service — 258k in / 15.9k out (weighted 6.2k), 5 legs, 15.4 min, 0 retries [sonnet-4-6 + opus-4-8]
- 06/12, 21:52 deep_dive Good Nature Organic Lawn Care — 257k in / 23.8k out (weighted 14.7k), 5 legs, 22.7 min, 0 retries [sonnet-4-6 + fable-5]
