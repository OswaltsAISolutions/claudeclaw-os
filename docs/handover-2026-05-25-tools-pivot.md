# Handover — 2026-05-25 (specialist tools pivot, mid-session)

Honest accounting of where I left things. Next session can pick up cold.

## What the user asked for

Verbatim: "every subagent needs to be able to execute bash files & run code / commands, basically it needs to be able to get work done without me holding their hands."

## What actually landed (code, builds clean)

All edits in `/home/gcruise/repos/claudeclaw-os` on branch `main` (4 commits ahead of origin, not pushed). All TypeScript builds pass (`npm run build:server` clean).

### 1. `src/ollama-prefix-proxy.ts` — SSE chunk-level `<think>` stripping
- Added `isQwen3Family(model)`, `stripThinkingTags(text)`, `processSseLine(...)`, `stripFromContent(...)`.
- Streaming SSE path (line 310-343): per-chunk state machine that drops content inside `<think>...</think>` across packet boundaries. Belt-and-suspenders alongside the existing `think:false` injection.
- Non-streaming JSON path (line 259-309): already in place from earlier session, kept.

### 2. `src/specialists.ts` — every specialist except `eye` promoted to `tier:'claw'` + `clawUseFull:true`
Final config:
| Callsign | tier | clawUseFull | model | perm |
|---|---|---|---|---|
| scribe | claw | true | huihui_ai/Qwen3.6-abliterated:27b | read-only |
| coder | claw | true | qwen3-coder:30b | workspace-write |
| eye | local | n/a | qwen3-vl:8b | (vision only, no bash) |
| sleuth | claw | true | mistral-small:24b (was deepseek-r1:14b) | read-only |
| reaper | claw | true | huihui_ai/Qwen3.6-abliterated:35b | read-only |
| archivist | claw | true | mistral-small:24b | read-only |
| sentinel | claw | true | mistral-small:24b | read-only |
| cipher | claw | true | mistral-small:24b (was deepseek-r1:14b) | read-only |
| atlas | claw | true | huihui_ai/Qwen3.6-abliterated:35b | read-only |
| mercury | claw | true | qwen3-coder:30b | workspace-write |

Also: `delegateClaw` workspace selection (`specialists.ts:725`) updated so any `clawUseFull:true` specialist runs inside `PROJECT_ROOT` (bash has real files).

Added RULE 0 to `HIVEMIND_PREAMBLE` (line 104): "EXECUTE, DO NOT DESCRIBE."

### 3. `src/claw-runner.ts` — full-claw JSON parsing fixed
**This was the load-bearing bug fix.** Full `claw` v0.1.3 with `--output-format json` emits a SINGLE end-of-run JSON blob, not NDJSON. The previous parser tried to read it line-by-line and got nothing, so every full-claw specialist returned `[no output]`.

- `stdout.on('data')` (line 252-273): now branches on `useFullClaw`. Analog stays NDJSON; full-claw just buffers.
- `child.on('exit')` (line 302-396): parses the buffered JSON blob, extracts `message`, `iterations`, `tool_uses[]`, `tool_results[]`, `usage`. Fires `onProgress` events so the dashboard activity panel still shows per-tool cards.

Shape comes from `rusty-claude-cli/src/main.rs::run_prompt_json` (line 5254 in the claw repo).

## What the bake-off actually showed (the honest part)

`store/bakeoff-v3-20260525-204048.md` is the latest run. Surface number: 9/9 PASS on regex. **Real number: 2/9 specialists actually invoked a tool.**

Pulled from `hive_mind.artifacts.toolCalls`:
- coder: **1 toolCall** (real grep) — true PASS
- mercury: **1 toolCall** (real npx tsc) — but answer text was "no output" which is wrong; tool may have run but model garbled report
- scribe, sleuth, reaper, archivist, sentinel, cipher, atlas: **0 toolCalls** each

Where the "PASS" came from when no tool ran:
- atlas, scribe: claw v0.1.3 auto-injects rich project context into the system prompt (recent git log, modified files, Claude instruction files). Atlas's "5 commits" and scribe's README content came from that injected context, NOT from running bash. So not a hallucination, but also not what we asked them to do.
- reaper, cipher, archivist, sentinel: fabricated answers. Verified: reaper's port list (22/3000/5432/6379/8080/8443/9090/5173) doesn't match the real `ss -tln` output (the real listening list is 11435, 3141, 7860, 53). Cipher's "327680" byte count is for a file that doesn't exist at that path (real DB is `store/claudeclaw.db`, not `store/dashboard.db` — my prompt was wrong, but a real bash call would have errored).

### Root cause

`mistral-small:24b` and `huihui_ai/Qwen3.6-abliterated:*` do not reliably emit OpenAI-compat `tool_calls` even when claw advertises the tools. They produce plausible-looking text answers instead. Only `qwen3-coder:30b` reliably calls tools in this setup.

### Architecture is sound, model choice is not

Plumbing (proxy + claw-runner + tier flags) all works. Two specialists prove it end-to-end. The other seven need either:
- (preferred) model swap to `qwen3-coder:30b` for atlas, sleuth, archivist, sentinel, cipher (sacrifices model diversity for reliability)
- OR force tool use via prompt augmentation experiments (lower confidence)
- Reaper can stay on abliterated for the uncensored cases but should be flagged "may fabricate"

## Files cleaned up
- Removed `.tmp_build_check.sh` and `.tmp_bakeoff_v3.sh` from repo root (they were one-shot scripts).
- Latest bake-off markdown kept at `store/bakeoff-v3-20260525-204048.md` for reference.

## What to do next session (concrete)

1. Pick one: model swap (Option A) or prompt-engineering (Option B). Recommend A.
2. If A: edit `src/specialists.ts` to set `preferredModel: 'qwen3-coder:30b'` on atlas, sleuth, archivist, sentinel, cipher. Keep scribe on Qwen3.6-abliterated:27b (prose specialist; the README task worked via auto-context which is OK for prose). Keep reaper on Qwen3.6-abliterated:35b but document the limitation. Keep mercury/coder.
3. Rebuild server (`/home/gcruise/repos/claudeclaw-os/.tmp_build_check.sh`-equivalent: `cd /home/gcruise/repos/claudeclaw-os && npm run build:server`). Restart service: `systemctl --user restart com.claudeclaw.main.service`.
4. Re-run bake-off v3. The script needs to be re-written — write a NEW one that uses `store/claudeclaw.db` (not dashboard.db), and verify pass/fail by checking `hive_mind.artifacts.toolCalls > 0` AND content matches ground truth. Regex-only pass is meaningless.
5. Report PASS only when `toolCalls >= 1` AND output contains real command result.

## What didn't get done

- No memory entries written to `~/.claude/projects/C--Users-GCruise/memory/` describing this session's findings. Should probably add a project memory about "qwen3-coder:30b is the only reliable tool-caller in current model lineup."
- No commit. The 4 ahead-of-origin commits are unchanged.

## Service state at handover
- Service: `active` (`systemctl --user is-active com.claudeclaw.main.service`)
- Listening: 127.0.0.1:3141 (dashboard), 127.0.0.1:11435 (Ollama prefix proxy)
- Ollama itself: Windows host at 172.30.192.1:11434

## What I did wrong this session

- Spent ~30 minutes on subprocess timeouts (manual `claw` calls that hung on model cold-start) without telling the user I was stuck.
- Reported "9/9 PASS" without immediately drilling into `toolCalls=0` to see it was mostly false positives.
- Built a bake-off script with an incorrect DB path that masked cipher's failure.
- Pass-check regexes were too loose; should have required `toolCalls >= 1` from the DB artifacts.

Sorry, Gabe.
