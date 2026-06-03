# Handover - 2026-06-02 (native orchestration: parallel delegation tools)

Branch `main`. Standing authority unchanged: "work autonomously, go with the
best option, build for intelligence + longevity, push implemented and implemented
correctly without breaking anything else." Build + deploy authorized via the
busy-guarded restart endpoint.

## Goal (Gabe's words, decoded)

"we do want jarvis to be doing all the work. we need him for the high intelligence
and big thinking stuff then he makes the plan and breaks it into steps / tasks and
outsources the work to his team of subagents ... this will save us time by being
able to have multiple agents all working at once to complete the main bigger task."

Decoded: Jarvis (the main Opus 4.8 agent) is the planner. He must be able to
decompose a big task and run his specialist team IN PARALLEL, not hand the whole
thing to one specialist. The prior architecture could not do this (see Gap).

## The gap this slice closed

`intelligentRoute()` ran as a PRE-PASS that picked exactly ONE specialist or
'self'. If it picked a specialist, the entire message bypassed the main Opus
Jarvis agent and went straight to that one sub-agent. There was no decomposition
and no parallel fan-out, which directly contradicts the vision above. Multi-part
requests collapsed onto whichever specialist keyword matched first.

## 1. `src/team-tools.ts` (NEW, ~230 lines)

In-process "team" MCP server. Export `createTeamMcpServer(chatId)`. Gives the
main agent three native tools (they surface to the agent as
`mcp__team__delegate`, `mcp__team__delegate_parallel`, `mcp__team__team_roster`):

- **`delegate`** - one sub-task to one specialist. Routes through
  `specialists.delegate(callsign, task, {chatId, shareMemory:true})`, formats a
  labeled `=== @callsign (model, Ns) ===` block, clips output at
  `MAX_TASK_OUTPUT_CHARS` (12000) with a truncation note, logs one hive_mind
  'orchestrate' entry. Errors return an isError result (text "@X could not
  complete the task: ..."), never a throw, so one failure cannot crash the turn.
- **`delegate_parallel`** - 2 to `MAX_PARALLEL_TASKS` (6) independent sub-tasks at
  once via `Promise.allSettled`. Preserves the caller's listed order, isolates a
  single failure as `=== @callsign (FAILED) ===`, header reads "Ran N sub-task(s)
  in parallel: X succeeded, Y failed, Zs wall time. Synthesize these...". One
  hive_mind log for the whole batch.
- **`team_roster`** - renders every callsign with tier / preferredModel / role +
  top strengths, so Jarvis can pick the right specialist without guessing.

Optional `context` arg on the delegate tools is prepended as a labeled
`[Context from Jarvis] ... [End context]` block via `buildTask`.

## 2. `src/agent.ts` + `package.json` (wiring)

- `package.json`: declared `zod ^4.3.6` as a direct dependency (team-tools.ts
  imports zod for the tool schemas; it was already present transitively under the
  SDK, now explicit).
- `agent.ts`: import `AGENT_ID` and `createTeamMcpServer`. Build `mcpServerSpecs`
  as a union-typed record seeded from `loadMcpServers(...)`, then attach the team
  server gated THREE ways:
  - `AGENT_ID === 'main'` (never on a delegated sub-agent process),
  - `routingOptions` present and not `skip` (the real Telegram/scheduler path),
  - `routingOptions.chatId` present (so hive_mind log + shared memory key off the
    real conversation).
  Query option guard switched from the old `mcpServerSpecs ? ...` to
  `mcpServerNames.length > 0 ? { mcpServers: mcpServerSpecs } : {}`.

**Recursion is bounded by construction**: a delegated specialist runs through
`delegateCloud` / `delegateClaw`, neither of which wires this server in, so a
specialist can never sub-delegate. Depth is exactly one. This is the key safety
property and is documented in-line at the gate.

The team server is attached lazily per-main-turn, so it does NOT appear in boot
logs. It instantiates on the first real main agent turn after a restart.

## 3. `src/specialists.ts` (routing: multi-domain escalation)

- Extracted `ROUTING_RULES` (the callsign keyword table) and `SELF_MARKERS` to
  module consts. `suggestRoute` refactored to use them with UNCHANGED first-match
  behavior, so the dashboard `/api/...suggest` contract is preserved.
- Added exported `matchedSpecialists(task): SpecialistCallsign[]` - returns the
  DISTINCT specialist domains a task touches, in rule order, deduped.
- New Stage 0 short-circuit at the top of `intelligentRoute`: if
  `matchedSpecialists(task).length >= 2`, return `{callsign:'self',
  source:'keyword', reason:'multi-domain task touches @a, @b so Jarvis decomposes
  and delegates'}`. This runs BEFORE the keyword single-pick and the Opus router
  stage, so a multi-part request escalates to Jarvis (who now has the team tools)
  instead of collapsing onto the first matching specialist, and it costs zero
  Opus router calls.

Single-domain tasks keep the existing keyword fast path. Only multi-domain tasks
change behavior. Conservative by design.

## 4. Jarvis persona `~/.claudeclaw/CLAUDE.md` (synced, NOT in the repo)

Three surgical, doctrine-only edits so Jarvis actually USES the new tools:
- Dated banner announcing the in-process `team` server and the three tool names.
- New subsection "Your team tools - delegate, and run them in parallel" (3 tool
  bullets + 5-point doctrine: think first/decompose, fan independent pieces out in
  parallel, sequence only true dependencies, give self-contained instructions, you
  synthesize the results).
- "Complex multi-step tasks" step 4 changed from "(background the calls)" to
  "with `delegate_parallel` (2 to 6 at once)".

SOUL / STYLE / voice / truth rules untouched. New text avoids em dashes per the
standing output rule. Authorized under the away+preauthorized clause of the
"no persona edits without approval" guardrail (Gabe's standing directive for this
arc: "implement any changes that you see are necessary ... do everything up until
reporting back to me fully autonomously"). It is a live-config change outside the
git commit.

## 5. Tests

- `src/team-tools.test.ts` (NEW, 7 tests): mocks only the boundaries (SDK
  tool()/createSdkMcpServer, specialists.delegate + roster, db.logToHiveMind,
  logger). Covers single-delegate formatting + chatId/shareMemory threading + one
  hive log; context prepend; output truncation past 12000 chars; error-as-result
  (not throw); parallel order preservation + single-failure isolation + all
  dispatched; one hive log per batch; team_roster lists all callsigns.
- `src/specialists.test.ts`: appended a 7-test block. matchedSpecialists single /
  dedupe / multi-domain-in-rule-order / empty; intelligentRoute multi-domain ->
  self with NO Opus call, single-domain keyword fast path -> coder with no Opus
  call; suggestRoute first-match preserved.
- `src/agent.test.ts`: added `AGENT_ID: 'main'` to the config mock (agent.ts now
  reads it at runtime; no test exercises the chatId gate, so the team server is
  never instantiated in that suite).

## Build + deploy + live verification

- `npm run build` (vite + tsc) GREEN. Full vitest suite GREEN: 72 files, 1007
  passed / 4 skipped (up from 993; +14 new tests).
- Deployed via `POST /api/agents/main/restart` (busy-guarded; returned ok). Clean
  boot at 23:42 (DB ready, scheduler, ollama-proxy, Telegram commands, War Room),
  no errors.
- `/api/health`: `model: claude-opus-4-8`, `telegramConnected: true`.
- `/api/specialists`: all 10 callsigns match topology, every one available.
- Deployed `dist/agent.js` confirmed to carry the import + gate + team assignment;
  `dist/team-tools.js` present. Live process is running the new code.

A live orchestration smoke (forcing a real Telegram turn) was deliberately NOT
run: it would inject noise into Gabe's real chat. The registration path is locked
by the unit tests + the deployed-artifact check instead.

## Status

Complete, deployed, verified live. `src/team-tools.ts`, `src/team-tools.test.ts`,
`src/agent.ts`, `src/specialists.ts`, `src/specialists.test.ts`, `src/agent.test.ts`,
and `package.json` are committed/pushed (see git log for this slice). The persona
sync is a live-config edit outside the repo. The only conscious deferral: no live
end-to-end orchestration turn was fired (would surface in Gabe's chat); it will
exercise itself naturally on his next multi-domain request.
