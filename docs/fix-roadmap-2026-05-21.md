# Fix Roadmap — 2026-05-21

You are Claude Code, picking up a multi-phase repair job on ClaudeClaw OS.
Diagnosis is already done. Your job is to execute the phases below **in
order**, end to end, without pinging Gabe between phases.

## How to use this file

- Work phases sequentially. Do not skip ahead. Do not bundle.
- After each phase: build → test → deploy → verify → update the PROGRESS
  table below → move to the next phase.
- **Stop and ask Gabe only if:** a build fails, a test fails, a verification
  step shows the fix didn't take, or you hit something not described here.
  Otherwise, keep going.
- War Room (Gemini Live voice) is **out of scope**. Gabe will fix billing
  himself tomorrow. Do not touch warroom/server.py.

## PROGRESS (update as you go)

| #   | Phase                                  | Status  | Notes |
| --- | -------------------------------------- | ------- | ----- |
| 1   | Restart guard (Bug 2)                  | done    | Implemented in src/dashboard.ts:2679-2748 (busy-check via getIsProcessing → 409, ?force=true override, SSE notice before spawn, audit row, then detached systemctl restart). Tests in src/dashboard.contract.test.ts:616-644 (2/2 passing 2026-05-26). PROGRESS table left "pending" because it was landed in a separate session and the table was not updated. |
| 2   | User-turn-first persistence (Bug 1)    | done    | User row lands &lt;1s of send; delegation + abort + error branches all persist; 28/28 bot.test.ts. |
| 3   | Orphan-message recovery on boot        | done    | Orphan audit-id 96 notified once via Telegram+SSE; recovery_log dedupes subsequent restarts (1 row, no duplicates). Schema added to runMigrations rather than file-based migration to match codebase pattern. |
| 4   | Error classifier — SIGTERM vs context (Bug 3) | done    | Regex-exact exit code parsing; exit 143/137 → service_terminated (was misclassified as context_exhausted via substring match); 29/29 errors.test.ts; new build live (PID 103556). |
| 5   | Memory consolidator: Gemini → Haiku 4.5 | done    | Direct trigger via tsx: Haiku produced consolidation id 1 (15 sources, 13 connections, contradiction detected) in 37.9s. Embeddings still on Gemini per roadmap (one 403 logged as warn, non-blocking). |
| 6   | Refactor saveConversationTurn          | done    | saveConversationTurn deleted; logAssistantTurn (assistant write + ingest) added to memory.ts; 3 happy paths in bot.ts switched; memory.test.ts updated; 42/42 memory+bot tests; grep src/ = 0 callers. |
| 7   | Service unit hardening                 | done    | Restart=on-failure, RestartSec=5, TimeoutStopSec=30, StartLimitIntervalSec=300, StartLimitBurst=5 (StartLimit* moved to [Unit] for modern systemd). daemon-reload run; existing PID 110090 unchanged per roadmap. |
| 8   | Tests + telemetry                      | done    | 75/75 tests across errors/memory/recovery/bot suites; new recovery.test.ts (4) + dashboard.contract busy-guard (2); telemetry: agent_error structured counter in both catch blocks, service_restart audit row confirmed live (id 98). |

---

## Environment cheat sheet

- Codebase: `/home/gcruise/repos/claudeclaw-os` (inside WSL Ubuntu)
- From Windows: `\\wsl.localhost\Ubuntu\home\gcruise\repos\claudeclaw-os`
- Service: `com.claudeclaw.main.service` (systemd user)
- DB: `store/claudeclaw.db` (sqlite, WAL mode)
- Dashboard: http://127.0.0.1:3141 (wslrelay-forwarded out of WSL)
- Telegram bot: @GCruiseJarvisBot, allowed chat id 2007603393
- Anthropic plan: **Max subscription** — multiple Claude models available
- Node version: managed via nvm at `~/.nvm/versions/node/v24.15.0/bin/node`

Run commands via: `wsl -- bash -c "cd ~/repos/claudeclaw-os && <cmd>"`

Useful checks:
- Health: `curl -s http://127.0.0.1:3141/api/health`
- Logs: `journalctl --user -u com.claudeclaw.main.service -n 50 --no-pager`
- DB peek: `sqlite3 store/claudeclaw.db "SELECT id, role, substr(content,1,80) FROM conversation_log ORDER BY id DESC LIMIT 5;"`

## Deploy procedure (use after every phase)

1. `npm run build` — writes new dist/, service keeps running old code
2. `npm test` — or at minimum the relevant test files
3. Restart: `systemctl --user restart com.claudeclaw.main.service`
   - **After Phase 1 lands, this must check the busy guard first.** If a
     task is in flight, abort the active query (`POST /api/chat/abort`)
     before restarting, or wait.
4. Verify: `curl -s http://127.0.0.1:3141/api/health` returns ok
5. Tail logs for ~10s to confirm clean startup, no immediate errors

**Never** chain `npm run build && systemctl restart` in a single shell line.
That's what caused the original incident.

---

# PHASE 1 — Restart guard (Bug 2)

**Why first:** Every subsequent phase requires a restart to deploy. Without
this guard, any restart you do can SIGTERM an in-flight user task and lose
their message (the original incident). Land this BEFORE touching anything
else so the rest of the work is safe.

## What to change

File: `src/dashboard.ts`, the `app.post('/api/agents/:id/restart', ...)`
handler. Currently around line 2604, the `main` branch spawns:
```
sleep 0.6 && systemctl --user restart com.claudeclaw.main.service
```

Replace with:

1. Before scheduling the restart, read `getIsProcessing()`. If
   `processing === true` and the request didn't include `?force=true`,
   return HTTP 409:
   ```json
   { "error": "busy", "reason": "agent_in_flight",
     "message": "An agent task is in progress. Abort it (/api/chat/abort) or wait, then retry. Pass ?force=true to override." }
   ```
2. When `?force=true` is passed (or no task is in flight), before spawning
   the restart, emit a chat notice so the user sees what's happening:
   ```ts
   if (ALLOWED_CHAT_ID) {
     emitChatEvent({
       type: 'assistant_message',
       chatId: ALLOWED_CHAT_ID,
       agentId: 'main',
       content: 'Restarting the service now. Any in-flight task did not finish. Re-send your last message after I come back (~3s).',
       source: 'dashboard',
     });
   }
   ```
   (Don't try to persist this to conversation_log yet — Phase 2 fixes that
   path. Just emit it to SSE for now.)
3. Then spawn the existing detached restart command. Keep the response
   shape backward-compatible: `{ ok: true, message: "Main bot restarting..." }`.

## Verify

- Send a long-running message via dashboard:
  ```
  curl -X POST 'http://127.0.0.1:3141/api/chat/send?token=$DASHBOARD_TOKEN' \
    -H 'Content-Type: application/json' \
    -d '{"message":"Run a deep research task that will take 2 minutes"}'
  ```
- While it's running, hit:
  ```
  curl -X POST 'http://127.0.0.1:3141/api/agents/main/restart?token=$DASHBOARD_TOKEN'
  ```
- Expect 409. Service must NOT restart. Active task continues.
- Retry with `force=true` in the query string and confirm the restart
  proceeds AND the SSE stream got the "Restarting the service now…" notice
  before the disconnect.

## Done criteria

- 409 returned when busy
- Force flag overrides
- Pre-restart chat notice fires
- No regression on the non-main agents/:id/restart path

Update PROGRESS table. Move to Phase 2.

---

# PHASE 2 — User-turn-first persistence (Bug 1)

**Why:** Today, `processDashboardMessage` and its Telegram twin only persist
the conversation turn AFTER `runAgent` returns successfully, via
`saveConversationTurn(chatId, userMsg, assistantMsg, ...)`. If the agent
is SIGTERM'd, aborted, or crashes mid-run, **neither** side gets persisted.
That's why Gabe's 9:40 PM message disappeared from Mission Control when he
switched tabs.

## What to change

File: `src/bot.ts`. Find every site that calls `saveConversationTurn`:
- `processDashboardMessage` (~line 1640, save at ~line 1709)
- Telegram processor (search for the equivalent save at ~line 699)
- Delegation handler (~line 505)

For each site:

1. **Before** `await runAgent(...)`, immediately persist the user turn:
   ```ts
   try {
     logConversationTurn(chatIdStr, 'user', text, sessionId, AGENT_ID);
   } catch (err) {
     logger.error({ err, chatId: chatIdStr }, 'Failed to persist user turn');
   }
   ```
   (Import `logConversationTurn` from `./memory.js` if not already imported.)

2. **After** runAgent returns, persist only the assistant turn:
   ```ts
   try {
     logConversationTurn(chatIdStr, 'assistant', rawResponse,
                         result.newSessionId ?? sessionId, AGENT_ID);
   } catch (err) {
     logger.error({ err, chatId: chatIdStr }, 'Failed to persist assistant turn');
   }
   // Memory ingestion is still fire-and-forget on the *pair*
   void ingestConversationTurn(chatIdStr, text, rawResponse, AGENT_ID).catch(() => {});
   ```
   Replace the existing `saveConversationTurn(...)` call with the block above.

3. **In the abort / timeout / error branches**, still write an assistant
   turn with the user-visible message. Today the abort branch only emits
   to SSE and returns. Persist these too so the chat history shows the
   abort instead of an orphan user turn:
   ```ts
   if (result.aborted) {
     const msg = result.text === null
       ? `Timed out after ${Math.round(AGENT_TIMEOUT_MS / 1000)}s. Try breaking the task into smaller steps.`
       : 'Stopped.';
     try {
       logConversationTurn(chatIdStr, 'assistant', msg,
                           result.newSessionId ?? sessionId, AGENT_ID);
     } catch (err) {
       logger.error({ err }, 'Failed to persist abort turn');
     }
     emitChatEvent({ type: 'assistant_message', chatId: chatIdStr,
                     content: msg, source: 'dashboard' });
     return;
   }
   ```
4. In the top-level catch around `processDashboardMessage` and the Telegram
   processor, also persist the classified error message as an assistant
   turn before re-throwing or returning. Match the pattern.

## Don't touch yet

Leave `saveConversationTurn` in `src/memory.ts` in place for now (other
callers may use it). Phase 6 refactors it.

## Verify

- Send a message: `POST /api/chat/send`. Within 1s, confirm a `user` row
  appears in conversation_log:
  ```
  sqlite3 store/claudeclaw.db "SELECT id, role, substr(content,1,60), created_at FROM conversation_log ORDER BY id DESC LIMIT 3;"
  ```
- While the agent is still running, kill it:
  `pkill -f claude-agent-sdk` (or hit `/api/chat/abort`).
- Reload `/api/chat/history?chatId=<allowed>&limit=5`. Confirm the user
  message stays visible AND an assistant turn with the abort/error
  message is present.
- Send another message normally and let it complete. Confirm both rows
  land, user first, assistant after.

## Done criteria

- User turn appears in DB before runAgent returns
- Mid-run kill leaves user turn intact and writes an abort assistant turn
- No double-write of either turn
- Telegram path verified the same way (DM the bot, kill the agent, reload)

Update PROGRESS. Move to Phase 3.

---

# PHASE 3 — Orphan-message recovery on boot

**Why:** Phase 2 plugs the hole going forward, but the audit_log already
contains messages that were never paired in conversation_log (Gabe's
9:40 PM message is one). On boot, surface any orphan so it's not lost
silently.

## What to change

Create `src/recovery.ts` with a function `recoverOrphanMessages()` that:

1. Queries `audit_log` for the most recent `action='message'` row per
   `chat_id` within the last 6 hours.
2. For each, checks whether `conversation_log` has a matching `user` row
   for the same `chat_id` whose `content` matches and whose `created_at`
   is within ~5 minutes of the audit row's `created_at`.
3. If no match → orphan. Send a one-shot Telegram + SSE notice to the
   user:
   ```
   "Heads up: I was restarted before I could finish your last message:
    \"<first 120 chars>...\". Want me to retry it? Reply 'yes' or resend."
   ```
4. Mark each handled orphan so we don't re-notify on every restart. Add a
   small table `recovery_log(audit_id INTEGER PRIMARY KEY, recovered_at INTEGER)`
   via a new migration in `migrations/`.

Call `recoverOrphanMessages()` once during startup, after the bot API is
ready and the DB is open. The right spot is in `src/index.ts` after the
dashboard server starts and the Telegram client is initialized. Wrap it
in try/catch and a 10s timeout so a recovery failure never blocks boot.

## Verify

- Use a fresh orphan in audit_log (manually insert one if needed, or stop
  the service mid-task from a test message before Phase 1's guard).
- Restart the service.
- Within 5s of startup, confirm a notice landed on Telegram and via SSE.
- Confirm the row was added to `recovery_log` and a second restart does
  NOT re-notify.

## Done criteria

- One-time orphan notice on first restart after the orphan exists
- No duplicate notices on subsequent restarts
- Boot is not blocked by recovery failures

Update PROGRESS. Move to Phase 4.

---

# PHASE 4 — Error classifier: SIGTERM vs context exhaustion (Bug 3)

**Why:** Today `classifyError` (src/errors.ts, ~line 101) labels
"Claude Code process exited with code 143" as `context_exhausted` and
tells the user to /newchat. That's wrong. Exit 143 is SIGTERM. The user
ends up doing useless workarounds.

## What to change

In `src/errors.ts`:

1. Add new categories:
   - `service_terminated` — exit 143 (SIGTERM) or 137 (SIGKILL/OOM)
   - Keep `context_exhausted` but match it on the real Anthropic API
     error: status 400 with body containing `context_length_exceeded`,
     `prompt is too long`, or similar — NOT on process exit codes.
2. Update `classifyError` to detect the exit-code path first. If the
   message matches `/Claude Code process exited with code (143|137)/`,
   classify as `service_terminated` with user message:
   > "I was restarted mid-task and lost what I was working on. Resend
   > the request and I'll start fresh."
3. Keep the existing recovery hints (`shouldRetry`, `shouldNewChat`, etc.)
   but for `service_terminated` set:
   - `shouldRetry: false`
   - `shouldNewChat: false` (the session is gone anyway, /newchat is moot)
   - `shouldSwitchModel: false`
4. Add unit tests in `src/errors.test.ts` (create if missing) covering:
   - exit code 143 → service_terminated
   - exit code 137 → service_terminated
   - real Anthropic 400 prompt-too-long → context_exhausted
   - generic Error → unknown / default

## Verify

- `npm test` passes new cases
- Trigger a mid-run kill (Phase 2 verification). Confirm logs show
  `category: service_terminated`, not `context_exhausted`.

## Done criteria

- New tests pass
- Real-world kill logs the right category
- User-facing message is the new "I was restarted…" copy

Update PROGRESS. Move to Phase 5.

---

# PHASE 5 — Memory consolidator: Gemini → Claude Haiku 4.5

**Why:** Memory consolidation calls Gemini 2.0 Flash and is hitting
429 quota every 30 min (free tier exhausted). Gabe is on Anthropic Max,
which includes `claude-haiku-4-5`. Haiku is fast, cheap, and accurate
enough for summarization/consolidation. Swap the provider; keep the
prompt and JSON output shape.

## What to change

File: `src/memory-consolidate.ts`, function `runConsolidation` (~line 59).

1. Replace the `@google/genai` import + client with the Anthropic SDK.
   The SDK is already in node_modules (`@anthropic-ai/sdk` or via the
   agent SDK). Check `package.json` and prefer the existing dependency.
2. Build the consolidation prompt the same way it's built today, but
   pass it to Anthropic Messages API with:
   - `model: 'claude-haiku-4-5'`
   - `max_tokens: 4096` (or whatever the current Gemini max output is)
   - Same system + user content
3. Parse the response back into the same JSON shape the rest of the code
   already expects. If today the code does `JSON.parse(geminiResp.text)`,
   keep that contract by extracting `response.content[0].text` and
   parsing it.
4. Remove the Gemini-specific 429 retry logic. Anthropic has different
   rate limits; add a simple exponential backoff (3 retries, 1s/2s/4s)
   on 429 or 529.
5. Keep the consolidation cadence as-is (every 30 min). Anthropic Max
   handles this volume easily.
6. **Do NOT remove `@google/genai` from package.json.** Other code may
   still use it (e.g., embedding generation). Just stop calling it from
   this file.

## Verify

- Manually trigger consolidation. Either:
  - Wait for the next 30-min tick, or
  - Add a one-shot dev command / call `runConsolidation()` from a REPL.
- Confirm:
  - New consolidation rows appear in the `consolidations` table
  - No 429 errors in logs after the swap
  - `journalctl ... | grep -i consolidation` shows successful runs

## Done criteria

- No more Gemini 429 spam in logs
- Consolidations table is growing again
- Insight quality looks comparable to pre-swap output (eyeball a few)

Update PROGRESS. Move to Phase 6.

---

# PHASE 6 — Refactor `saveConversationTurn` away

**Why:** The combined function is what enabled Bug 1 in the first place.
Phase 2 worked around it by calling `logConversationTurn` directly at the
call sites. Now delete the combined helper so nobody can reintroduce the
bug.

## What to change

1. Remove `saveConversationTurn` from `src/memory.ts`.
2. Move the `void ingestConversationTurn(...)` fire-and-forget call into
   a small helper `logAssistantTurn(chatId, userMsg, assistantMsg, sessionId, agentId)`
   that:
   - Calls `logConversationTurn(chatId, 'assistant', assistantMsg, ...)`
   - Fires `ingestConversationTurn(chatId, userMsg, assistantMsg, ...)` in
     the background
3. Update the Phase 2 call sites in `src/bot.ts` to use `logAssistantTurn`
   instead of bare `logConversationTurn` for the assistant write. The
   user write stays a direct `logConversationTurn('user', ...)`.
4. Grep the codebase for any remaining `saveConversationTurn` callers and
   convert them. Should be zero by the end:
   ```
   grep -rn 'saveConversationTurn' src/ scripts/ web/ warroom/
   ```

## Verify

- TypeScript build succeeds with no references to `saveConversationTurn`
- All conversation-persistence tests still pass
- Manually send a message and confirm both rows land plus memory
  ingestion fires (check `memories` table for recent inserts)

## Done criteria

- `saveConversationTurn` is fully removed
- All callers use `logConversationTurn` / `logAssistantTurn`
- No regression in chat persistence or memory ingestion

Update PROGRESS. Move to Phase 7.

---

# PHASE 7 — Service unit hardening

**Why:** The current unit uses `Restart=always`, which masks crash loops
and gives no visibility into why restarts happen.

## What to change

Edit `~/.config/systemd/user/com.claudeclaw.main.service`:

```
[Service]
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
StartLimitIntervalSec=300
StartLimitBurst=5
```

After edit:
```
systemctl --user daemon-reload
# Do NOT restart here — Phase 1 guard would block if a task is in flight.
# Restart on the next deploy boundary or via the dashboard endpoint.
```

## Verify

- `systemctl --user show com.claudeclaw.main.service --property=Restart,RestartUSec,TimeoutStopUSec`
  reflects the new values
- Service still comes back up after a normal restart
- If you deliberately make it crash 5x in 5 minutes (e.g., bad env), it
  enters failed state instead of restart-looping forever

## Done criteria

- Unit file updated
- daemon-reload run
- New restart policy active

Update PROGRESS. Move to Phase 8.

---

# PHASE 8 — Tests + telemetry

**Why:** Lock in the fixes so future changes don't regress them.

## What to add

1. **Tests** in `src/*.test.ts`:
   - `errors.test.ts` — Phase 4 cases
   - `bot.test.ts` (or extend) — user-turn-first persistence pattern:
     - mock runAgent to throw; assert user row is in DB
     - mock runAgent to abort; assert abort assistant row is in DB
     - mock runAgent to succeed; assert both rows + memory ingest
   - `dashboard.test.ts` — busy guard returns 409 when processing=true
     and proceeds when processing=false; force=true overrides
   - `recovery.test.ts` — orphan detection + recovery_log dedupe

2. **Telemetry**:
   - In `classifyError`, log a structured counter line on each
     classification: `{ event: 'agent_error', category, agentId }`.
   - Add a small `audit_log` action `service_restart` written from the
     restart handler so we can later answer "how many times did we
     restart, who triggered it." Fields: `agent_id='main'`, `chat_id=''`,
     `action='service_restart'`, `detail=JSON.stringify({ forced, busy_at_request })`.

## Verify

- `npm test` passes everything green
- Restart the service via the dashboard, confirm a `service_restart`
  row landed in audit_log
- Trigger a kill, confirm an `agent_error` log line with
  `category: service_terminated`

## Done criteria

- All new tests pass
- Telemetry rows show up under expected actions

Update PROGRESS to all-done. STOP and ping Gabe with a one-paragraph
summary of what shipped + anything notable from execution.

---

## Voice rules (apply to all chat/Telegram output you write)

The Jarvis persona at `~/.claudeclaw/CLAUDE.md` enforces:
- No em dashes. Ever.
- No AI clichés ("Certainly", "Great question", "I'd be happy to", "As an AI", "absolutely").
- No sycophancy or flattery.
- Don't narrate intent. Just do.
- Address Gabe as "Gabe" or "Gabriel" or "boss/dude/man" sparingly.

Any user-facing string you add (chat notices, error messages, recovery
prompts) must obey these. Code-internal logger messages are fine in any
voice.

---

## Out of scope

- War Room voice (Gemini Live). Gabe is fixing billing tomorrow.
- Avatar / file upload paths. Not part of this incident.
- Cloud subagent topology / multi-Opus setup. Separate workstream.
- The `/dashboard` URL routing changes Jarvis was mid-shipping when
  the original incident hit. Don't try to recover that work; let
  Gabe re-request it after these fixes land.
