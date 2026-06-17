# RESUME — Multi-PC Architecture lane (resume with "resume architecture")

**Lane:** cross-PC hive mind. PC: Desktop 2. Last update: 2026-06-17.

## State
- Phase 1 (git-synced `docs/` coordination + boot protocol + registry) = DONE, off-limits.
- Phase 2 (live cross-PC link) = DESIGNED, not built. Authoritative plan: **docs/PHASE2-HIVE-PLAN.md**.
- Nothing shipped to the service. No restart performed. No code edited (docs only this session).
- A fresh clone of the repo exists on Desktop 2 at `C:\Users\oswal\claudeclaw-os` (Windows side; no WSL/Node here, so this PC cannot gate/build the service).

## The design in one paragraph
Expose the Main-PC WSL service (Hono :3141, loopback) to the other PCs over Tailscale via `tailscale serve` running INSIDE WSL (DASHBOARD_BIND stays loopback, Funnel off). Add additive `/api/hive/register|status|notes` Hono routes with their own `HIVE_TOKEN` (query-param auth; the server never reads the Authorization header), backed by additive `hive_sessions` + `hive_notes` SQLite tables in `createSchema()`. Read-time TTL self-expiry, `HIVE_ENABLED` kill switch, curl/PowerShell spoke clients (modeled on `scripts/notify.sh`) that fall back to UPDATING this PC's `SESSION-REGISTRY.md` row when the hub is unreachable.

## Next steps (ordered)
1. Gabe answers the 6 open decisions in docs/PHASE2-HIVE-PLAN.md section 9 (especially D3 real unit name + D4 WSL2 Tailscale reachability).
2. On the MAIN PC (where the gate + build + restart live), implement plan steps 1-7 (config, kill switch, schema, DAL, routes+auth, tests, .env) on a branch.
3. Run the gate (`tsc` x2 + `vitest`) green, `npm run build`, restart the service.
4. Step 8: `tailscaled` + `tailscale serve` inside WSL; verify `tailscale ip -4` returns a 100.x address.
5. Step 9: spoke client + boot hook on Desktop 2 + laptop; E2E test from Desktop 2 over Tailscale (plan section 8).
6. Optional later: step 10 dashboard "Live Sessions" panel; section 7 cross-PC memory.

## Watch out
- Keep all schema ADDITIVE; do NOT bump `migrations/version.json` (`checkPendingMigrations` hard-exits the process -> breaks the Layer-1 git-doc fallback).
- `hive_*` is DISTINCT from the existing `hive_mind` table / `/api/hive-mind` feed / `/hive` page; do not overload either.
- Desktop 2 has no Node; never run the gate/build here. Build on the Main PC only.
