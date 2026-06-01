# Handover - 2026-05-31 (atlas reliability investigation)

Picked up follow-up #2 from `docs/handover-2026-05-26-four-task-slice.md`
("Atlas git_diff reflex"). Outcome: the ordering reflex is fixed via
prompt, but the residual flake is a qwen3-coder:30b ceiling, not a tooling
gap. A deterministic tool-allowlist fix was tried and reverted because it
backfired. One decision is left for Gabe (model tier).

## What the user asked for

Verbatim: "if it's a super easy fix i want to go with the fix that is best
for our system in the long run, ensure atlas have all the permissions and
abilities and tools that he needs to do his job at maximum efficiency. al
models need to be able to do things on their own and run commands,
write/read both, use tools etc"

Two asks: (1) fix the atlas flake the long-term-correct way IF super easy,
(2) make sure atlas (and ideally all specialists) have full tools and
permissions to act autonomously.

## Ask (2): full tools/permissions - DONE and verified

Atlas is `tier: claw`, `clawUseFull: true`, and now `clawPermission:
'workspace-write'` (this session bumped it from read-only). Per
`src/specialists.ts:778-780`, any full-claw or workspace-write specialist
runs with `workspace = PROJECT_ROOT`, so atlas executes inside the real
repo with bash, read_file, write_file, edit_file, glob_search, grep_search
all working. That covers "run commands, read/write, use tools." No gap.

## Ask (1): the flake - root-caused, partially fixed

**bash-first ordering is FIXED.** A per-specialist TOOL DISCIPLINE block
was added to atlas's `systemPrompt` (the only kept code change this
session). Across ~30 verification runs, atlas now always calls bash FIRST;
the original "git_diff/git_status before bash" reflex is gone (0
occurrences).

**Residual ~45% failure = post-answer over-exploration.** After bash
returns the value, qwen3-coder:30b about half the time ignores the
explicit "STOP, do not call GitStatus/GitDiff" instruction, calls the
dedicated Git* tools anyway (they run against claw's sandbox cwd and
intermittently error with "not inside a git repository" or return an
unrelated repo diff), then derails its final answer into summarizing that
instead of reporting the asked value. Also occasional conversational
deflection ("Got the hash, what next?") and rare stray XML. Clean rule
from the data: every single-tool-call run PASSES, every multi-tool-call
run FAILS. This is a model instruction-following ceiling.

## What was tried and REVERTED: claw --allowedTools

The deterministic fix was to strip the broken Git* tools via claw's
`--allowedTools` allowlist (canonical names: bash, read_file, write_file,
edit_file, glob_search, grep_search). Wired through `ClawRunOptions` +
both arg-assembly paths in `src/claw-runner.ts` and a per-specialist
`clawAllowedTools` in `src/specialists.ts`.

It backfired. Restricting the toolset makes qwen3-coder:30b emit
unparseable OpenAI-style XML tool-call syntax (`<function=bash>...`) ~50%
of the time; claw v0.1.3 can't parse it (toolCalls=0), the built-in
stray-syntax retry also fails, and the pass rate collapsed. All allowlist
wiring was reverted; `src/claw-runner.ts` is back to its committed state.
Do NOT retry the allowlist approach with this model + claw version.

## Verification data (bake-off-strict: toolCalls>=1 AND output contains GT hash)

| Config | Pass | Stray XML |
|---|---|---|
| Prompt-harden, no allowlist (8 runs) | 5/8 | 0 |
| + `--allowedTools` (10 runs) | 1/10 | 5 |
| Allowlist reverted, prompt-harden (12 runs) | 6/12 | 0 |

Aggregate for the kept config (prompt-harden, no allowlist): 11/20 (~55%),
with single-call=pass / multi-call=fail holding every time.

Note: the bake-off task (echo a 7-char git hash) is a poor proxy for
atlas's real job (planning, architecture review, synthesis), where
"over-exploration" is often correct thoroughness. The number understates
atlas's usefulness on real supervisory work.

## Decision left for Gabe (touches the local-specialist pivot)

Levers for higher reliability on literal-output tasks, none "super easy":
1. **Accept current state.** Atlas has full tools/permissions; the flake
   mostly bites trivial echo tasks, not real reasoning work.
2. **Route atlas to its configured `cloudModel` (claude-opus-4-7).** Aligns
   with the intelligence-over-cost stance and the Max plan, but reverses
   the 2026-05-25 local-specialist pivot. Atlas is the top supervisor tier,
   the most defensible place to spend cloud.
3. **Try `clawDisableFilesystemSandbox: true` for atlas** so `.git` is
   reliably visible and the Git* tools stop erroring mid-task. Untested;
   widens atlas's filesystem access.

## Service / tree state at handover

- Branch `main`. This session's only net source change:
  `src/specialists.ts` (2 lines: atlas TOOL DISCIPLINE prompt block +
  read-only to workspace-write). `src/claw-runner.ts` matches HEAD.
- `scripts/bakeoff-v4.sh` has a small atlas-task guard tweak from this
  session.
- The fix is built into `dist/` (verified via `specialist-cli delegate`,
  which bypasses the live service). The LIVE service still runs the old
  in-memory code; a `systemctl --user restart com.claudeclaw.main.service`
  is needed to deploy the atlas prompt fix to Jarvis. Not done (deploy
  decision + prior-session working-tree noise left untouched per guardrail).
- Prior-session uncommitted noise still present (package*.json, src/agent,
  src/bot, src/dashboard, src/db, web/, etc.). None touched this session.
- Scratch (safe to delete): `scripts/.atlas-verify.sh`,
  `scripts/.atlas-diag.py`. Kept in case Gabe picks lever 2 or 3 and wants
  a re-test harness.
