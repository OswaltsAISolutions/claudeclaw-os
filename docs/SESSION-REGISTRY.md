# SESSION-REGISTRY — who/what is live across all PCs

**How to use:** at boot, `git pull`, then add or update your row. Keep one row per active session. Set status `inactive` (or delete your row) when you stop. Commit + push after changes. Timestamps in EST, date-level is fine if you cannot get the clock.

| PC | Lane / session | Status | Working on | Last update |
|---|---|---|---|---|
| Main PC (WSL service host) | Agency + system (built GN package, model swap, hive-mind docs) | active | Created HANDOVER / HIVE-MIND / this registry; agency dive run PAUSED | 2026-06-15 |
| Desktop 2 | Multi-PC AI system architecture | (self-register) | Building cross-PC architecture (Phase 2 live link) | 2026-06-15 |
| Gaming laptop | (to be added) | offline | Not yet set up | - |

## Notes
- The live ClaudeClaw service + SQLite DB run ONLY on the Main PC. Other PCs coordinate via this repo (git) until Phase 2 networking exists.
- This is a Layer-1 (async, git-synced) registry. A self-expiring live registry is Phase 2 (see HIVE-MIND.md).
- To message another session: write a dated, addressed line in SESSIONS.md "Notes between sessions"; they see it on their next `git pull`.
