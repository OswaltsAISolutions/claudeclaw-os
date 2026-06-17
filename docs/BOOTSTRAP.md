# BOOTSTRAP — how every new Claude Code session picks up work

> **Enforcement layer:** `C:\Users\GCruise\CLAUDE.md` (the project root) is
> auto-injected into EVERY new Claude Code session as standing orders: it
> forces brand-new sessions to read SESSIONS.md, claim a lane, and follow the
> concurrency rules BEFORE touching anything: no prior briefing required.

Gabe's standing system (adopted 2026-06-11) so sessions stay SHORT and CHEAP
while losing zero context. The intelligence lives in files, not chat history.

## The three layers

1. **Auto-memory** (loads automatically every session): who Gabe is, standing
   rules, project summaries, and pointers to the files below. Nothing to do.
2. **Lane state files** (this folder):
   - `SESSIONS.md` — cross-session coordination: active lanes, rules, restart log.
   - `RESUME-<lane>.md` — the live savefile per lane: exact state, commands,
     ordered next steps, standing rules. THE source of truth for "where we left off".
3. **The trigger**: Gabe types one line in a new session (see below).

## Gabe's one-line starters (type one of these in any new session)

- `resume agency` → read SESSIONS.md + RESUME-agency-research.md, confirm state in one short paragraph, continue the next-steps list.
- `resume finance` → read SESSIONS.md + RESUME-finance.md, same drill.
- `resume content` → content lane (that session keeps its own RESUME file).
- Or paste this if the one-liner ever fails:
  > New session picking up ongoing work. Read /home/gcruise/repos/claudeclaw-os/docs/SESSIONS.md and the matching docs/RESUME-*.md for the lane I name, confirm where things stand in ONE short paragraph (no re-research, no re-litigating decided things), then continue from the RESUME file's "what to do next" list. Keep the RESUME file updated after every completed slice.

## Running MULTIPLE fresh sessions at once (the standing model)

Gabe can boot any number of fresh sessions at any time, all working the same
Mission Control. They never collide because:

1. **Lanes are the partition.** Each session works ONE lane (Gabe names it:
   "resume agency" etc.). The lane's feature areas in SESSIONS.md are its
   territory; everything in another lane's row is hands-off. Shared files
   (db.ts, dashboard.ts, bot.ts, index.ts, routes.ts, App.tsx, Library.tsx)
   are edited additively, re-read on conflict, never reverting other lanes.
2. **Starting a BRAND-NEW lane** (a task no RESUME file covers): first add a
   row to the SESSIONS.md lane table (name, scope, feature areas, claimed
   shortcut keys), create `RESUME-<lane>.md` from the others' shape, THEN
   build. The registration IS the claim: other sessions read it before touching
   anything.
3. **Talk through SESSIONS.md notes**, log restarts before restarting, and
   never build on a red typecheck (a build compiles every lane).

## One shared memory (the map of what lives where)

- **Auto-memory** (`~/.claude/projects/C--Users-GCruise/memory/`): SHARED by
  every Claude Code session in this project, loaded automatically. Durable
  truths (who Gabe is, rules, project states) go here THE MOMENT they're
  learned, so concurrent sessions see them immediately.
- **Repo docs/** (this folder): cross-session WORK state: BOOTSTRAP (this
  protocol), SESSIONS.md (coordination), RESUME-<lane>.md (savefiles),
  handover-*.md (history). Jarvis can read these too (his repo, his tools).
- **Jarvis runtime memory** (hive_mind + persona + KB): the bot's own store,
  shared across his whole specialist team by design. Jarvis's persona points
  to this docs/ folder for "what are the build sessions working on".
- Net effect: one hive mind: a fact written in any layer is reachable from
  every session and from Jarvis, without any session carrying it in chat
  history.

## Session-discipline rules (for every Claude session)

1. **Update your lane's RESUME file after EVERY completed slice**, not just at
   session end. A crash or cap-hit must never lose state.
2. **End sessions at natural stopping points, and SAY SO.** When a slice lands
   and the RESUME file is current, wrap up. Marathon sessions burn the weekly
   Max allowance on context re-reading; fresh sessions reading savefiles do not.
2b. **Freshness tripwire (every session must self-enforce):** the moment a
   session notices it has been compacted, OR has shipped ~3+ substantial
   slices, OR spans more than one work block, it finishes the current slice,
   updates its RESUME file, and proactively tells Gabe: "Good stopping point:
   this session is getting expensive per message; type `resume <lane>` in a
   fresh one." Never let Gabe discover the burn from his usage meter.
3. **Don't re-derive what's written.** If the RESUME file says a decision was
   made, it was made; ask Gabe only about genuinely new decisions.
4. **Default model context:** plain `claude-fable-5` is plenty; the `[1m]`
   long-context variant multiplies cost and is only for genuinely huge
   single-session needs.
5. Background work belongs in the SERVICE (workers, queues, schedulers), not
   in sessions: it runs at zero session cost and survives everything.

## Current lanes and their savefiles

| Lane | RESUME file | Owner session |
|---|---|---|
| Agency (clients, dossiers, storefront) | RESUME-agency-research.md | Finance+Business |
| Finance (Edge Scanner, paper book, gate) | RESUME-finance.md | Finance+Business |
| Content (Studio, Edit Bay, sweeps) | RESUME-content.md | Content Engine |
