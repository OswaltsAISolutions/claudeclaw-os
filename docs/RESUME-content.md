# RESUME: Content lane (Content Engine + Edit Bay + faceless workbench)

**Updated 2026-06-12 ~11:20 EST (Director v2 slice shipped). Read this + docs/SESSIONS.md first, confirm state in one paragraph, then pick up at "What to do next".**

## Where things stand (everything below is DEPLOYED and runs in com.claudeclaw.main.service, not in any session)

- **Content Engine (anchor/face lane): COMPLETE and self-running.** Saves + live sweeps (8:00/18:00) -> gated/scored/clustered -> /studio -> brief -> AUTO fact-check (hard gate: no script until verified; not-filmable banner if 0 confirmed) -> script obeying verdicts -> teleprompter (/prompter/:draftId) + receipts kit + publish kit. Telegram pings + 2am-recap CONTENT OPPORTUNITIES section live. Two VERIFIED scripts are waiting for Gabe to record (Army-intel story is the strongest).
- **Edit Bay (/editbay, g v): the editing studio.** Remotion project in `video/` (own package.json; compositions CaptionedClip + Timeline picked up per render, NO service restart needed for video/src changes). render_jobs worker (serial): kind `caption_clip` (word-synced captions; HARD GATES: vision pre-flight refuses already-captioned sources and no-safe-zone frames) and kind `timeline` (Director-planned edits). Director = atlas writes the plan from brief + per-source vision reports; CODE validates (segment math, overlay zones, caption legality). QC inspector reviews finished frames -> ready | qc_failed (output kept; retry re-runs the whole pipeline).
- **Director v2 (shipped 2026-06-12):** overlay legality is now judged per overlay WINDOW (zones of the segments it actually appears over, not the whole-video union; caption zone recomputed over USED sources only). QC fail auto-revises: issues + a summary of the failed plan go back to the Director for ONE corrected plan, re-render, then ready or qc_failed (`spec.qc_round` records the round). Vision materials gathered ONCE per job; narration audio cached by text so a revision never re-spends EL credits. Job completion now syncs the owning edit_project: ready -> 'done', failed/qc_failed -> 'approved' (projects can no longer stick at 'rendering'; the one stuck row ef04ef5a was fixed by hand).
- **Faceless workbench (Edit Bay "Projects"): SHIPPED, full e2e passed** (create -> pick clips -> idea/script/brief -> voiceover upload -> non-blocking fact labels -> render -> QC pass). First QC-passed video: store/renders/3762f43a. The ALIGNMENT CONTRACT with Gabe is auto-memory `project_faceless_channel.md` — read it before touching this lane; the 10 answers are binding (he picks every video; most have NO narration; labels never block; he always posts).
- **Narration**: src/narrator.ts, ElevenLabs key in .env (TTS-ONLY scope: cannot list voices/tier; quota errors surface on calls). Default voice = ELEVENLABS_VOICE_ID auq43ws1oslv0tO4BDa7 (his pick, rare use). ~1 credit/char.
- **Whisper server (127.0.0.1:3147)**: supports `words:true`. CURRENTLY a nohup process (replaced the boot-started one on 2026-06-10); the startup script relaunches it on reboot. If down: `nohup /home/gcruise/venvs/media/bin/python scripts/whisper_server.py > /tmp/whisper.log 2>&1 &` from repo root.
- **Vision**: src/edit-vision.ts -> qwen3-vl:8b on HOST-Windows Ollama via resolveOllamaBaseUrl() (gateway IP, NOT 127.0.0.1). Gotchas baked in: think:false ignored (num_predict 1400, read content||thinking); never put a literal JSON example in vision prompts (model echoes it; extract LAST brace-balanced block).

## Status checks

```bash
# service + render queue
wsl -d Ubuntu -- bash -lc "curl -s 'http://127.0.0.1:3141/api/health?token='$(grep '^DASHBOARD_TOKEN=' /home/gcruise/repos/claudeclaw-os/.env | cut -d= -f2-) | head -c 200"
wsl -d Ubuntu -- sqlite3 /home/gcruise/repos/claudeclaw-os/store/claudeclaw.db "SELECT status, COUNT(*) FROM render_jobs GROUP BY status; SELECT id,title,status FROM edit_projects ORDER BY updated_at DESC LIMIT 5;"
# studio opportunities
wsl -d Ubuntu -- sqlite3 /home/gcruise/repos/claudeclaw-os/store/claudeclaw.db "SELECT COUNT(*) FROM library_items WHERE intent='content' AND status='ready';"
```

## What to do next (in order)

1. **Evidence pop-ins**: URL -> article/doc screenshot -> Timeline `image` overlay at the cue. Needed for the faceless documentary style (his style ref: library item 9b873175). NOTE: place them through the Director so the per-segment zone check applies (PlanOverlay kind 'image' exists but the Director never emits it yet).
2. **Brand kit session WITH Gabe** (taste, don't guess): channel fonts/colors/caption style/transition + intro as Timeline defaults. Do this when he creates the faceless accounts.
3. **Music/SFX library**: store/music/ seeded with free tracks tagged by mood; Timeline duckUnderSpeech already works.
4. **Suggestion layer**: new saves that fit collage/edit material -> faceless IDEA suggestions (chips/ping). NEVER auto-produce (contract rule 1).
5. **Kokoro local TTS** for draft narration (EL = finals only).
6. Content Engine smalls: sweep query rotation, re-verify button after 'done', sweep-item thumbnails.
7. Anchor lane E2 (raw-take editing: silence/retake cuts, receipts overlays) ONLY when Gabe starts filming.
8. (Verify when a real render happens) Director v2 revise loop end-to-end on a QC failure — unit-level logic is typechecked + deployed, but no qc_failed has exercised the live loop yet.

## Waiting on Gabe (do not nag every session; check off when done)

- Record the first anchor video (Army-intel verified script, teleprompter ready).
- Create faceless accounts (then brand kit + first real workbench video).
- Regenerate X Client Secret (old one was pasted in chat 2026-06-10) + re-add to .env + restart.
- One-time X/IG logins inside the Feeds tab (neko admin password in docker/neko/.env).

## Standing rules (do not violate)

- Faceless contract in `project_faceless_channel.md` (binding 10 answers). Caption rules in `feedback_caption_rules.md` (never double-caption, never over content, backing panel, safe zones).
- Hard fact-gate is ANCHOR-ONLY. Faceless = label, never block.
- Never post anywhere; Gabe always posts. Never spend without approval (EL credits count: ~1/char, finals only).
- Concurrent-session rules in docs/SESSIONS.md (additive schema, typecheck both + vitest before build, log restarts there BEFORE restarting).

## Related state (other lanes, FYI)

- Finance + Business lane: own savefiles (RESUME-finance.md, RESUME-agency-research.md); hands off edge_*/clients tables and /edge,/clients pages.
- Full lane history: auto-memory `project_content_engine.md`, `project_edit_bay.md`, `project_faceless_channel.md`, `project_content_library.md`.
