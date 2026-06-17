# HIVE-MIND — how all Claude sessions share context + coordinate (across PCs)

**Goal:** any Claude Code session, on any of Gabe's PCs, boots with full system context and can coordinate with every other session (Jarvis/agency/content/finance/architecture) so they work side by side without colliding.

## The honest design (what is real vs aspirational)

Claude Code sessions do **not** message each other in real time, on the same machine or across machines. The hive mind is built on a **shared, synced brain that every session reads at boot and writes to as it works.** That makes coordination **asynchronous** but reliable. This is already how concurrent same-PC sessions coordinate (via SESSIONS.md); this doc extends it across PCs.

**The brain = this git repo's `docs/` folder. The sync layer = git.** (`OswaltsAISolutions/claudeclaw-os`, branch `main`.) Git is the right choice over a cloud-synced folder: it is versioned, merge/conflict-aware, offline-tolerant, and you already have it. Every PC clones it; sessions `pull` at boot and `push` after updating shared state.

```
   Main PC (WSL)            Desktop 2              Gaming laptop
   ClaudeClaw service   Claude Code session    Claude Code session
        |  docs/             |  docs/                |  docs/
        +---------- git (origin: GitHub) ------------+
                    shared brain, pull/push
```

### Two layers
- **Layer 1 (LIVE NOW): async coordination via the synced docs.** Registry + notes + savefiles in `docs/`, synced by git. Near-real-time if sessions pull/push around their work. Robust today.
- **Layer 2 (PHASE 2 build): live cross-PC link via the service.** Expose the ClaudeClaw service (127.0.0.1:3141) across the network (Tailscale/LAN/tunnel) so off-PC sessions can POST status + read the live hive_mind DB in real time, and so the central Jarvis becomes a true hub. Requires networking + auth work; scoped, not free. Build it on the architecture lane.

## The coordination files (in `docs/`)

- **HANDOVER.md** — full system context (read first).
- **SESSION-REGISTRY.md** — the live roster: which PC, which session/lane, status, last-updated. Register at boot, update on status change, mark inactive at end.
- **SESSIONS.md** — lane table + restart log + "Notes between sessions" (the async message board).
- **RESUME-<lane>.md** — per-lane savefile (state + ordered next steps), updated after every slice.

## The protocol (every session, every PC)

1. **Boot:** `git pull`. Read HANDOVER -> SESSIONS -> SESSION-REGISTRY -> your RESUME.
2. **Register:** add/update your row in SESSION-REGISTRY.md (PC, lane, status=active, what you are doing, UTC timestamp). Commit + push.
3. **Work:** stay in your lane; additive-only on shared files; re-read a shared file if another session may have touched it.
4. **Communicate:** to talk to another session, write a dated line in SESSIONS.md "Notes between sessions" addressed to the lane (they read it on their next pull). For status, update your registry row.
5. **Checkpoint:** after each slice, update your RESUME + push, so any PC sees current truth.
6. **Conflicts:** if `git push` rejects, `git pull --rebase` and re-apply (docs are append-mostly, so conflicts are rare and easy). Never overwrite another lane's section.
7. **End:** set your registry status=inactive (or remove your row), final RESUME update, push.

## Setup per new PC (one time)

1. Install git + Claude Code; sign into the same Claude account.
2. `git clone https://github.com/OswaltsAISolutions/claudeclaw-os.git` (pick a path).
3. Create a `CLAUDE.md` at that PC's working root that says: *"You are one of multiple Claude sessions across multiple PCs sharing one brain. At boot: cd the clone, `git pull`, read docs/HANDOVER.md, docs/SESSIONS.md, docs/SESSION-REGISTRY.md, then your lane's RESUME. Register in SESSION-REGISTRY.md. Additive-only on shared files; pull before / push after touching docs."* (Mirror the main PC's `C:\Users\GCruise\CLAUDE.md` standing orders.)
4. (Optional, Phase 2) install Tailscale on all PCs so the main PC's service is reachable for live coordination.

## What does NOT auto-sync (be honest about it)

- The **running service + SQLite DB** live only on the main PC. Other PCs see the *docs*, not the live DB, until Phase 2 networking.
- **Auto-memory** (`~/.claude/.../memory/`) is per-machine. Until Phase 2, treat the repo `docs/` as the cross-PC source of truth; durable facts that must cross PCs go in HANDOVER/SESSIONS/memory-mirrored-to-docs, not only in a single PC's auto-memory.

## Phase 2 backlog (the real multi-PC build, for the architecture lane)
- Expose the service over Tailscale + a shared token; add `/api/hive/register`, `/api/hive/status`, `/api/hive/notes` so sessions on any PC post/read live.
- A heartbeat so the registry self-expires stale sessions.
- Optional: sync the auto-memory store cross-PC (or centralize memory in the service DB and have all PCs read it over the network).
- A boot hook that auto-pulls + prints the registry so a new session is instantly oriented.
