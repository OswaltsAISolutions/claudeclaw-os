#!/usr/bin/env bash
# Bake-off v4 — strict verification for the 2026-05-25 model-swap pivot.
#
# v3's regex-only pass criterion produced false positives: 9/9 "PASS" while
# only 2 specialists actually invoked a tool. This version requires BOTH:
#   1. hive_mind.artifacts.toolCalls >= 1 for the run (the model actually
#      called a tool, not just produced plausible text).
#   2. Specialist output contains the real ground-truth value computed by
#      this script directly via bash (not a regex over a vocabulary list).
#
# Designed to run after `npm run build:server` and a service restart.
# Output: store/bakeoff-v4-<ts>.md
#
# Test ordering minimizes Ollama cold-loads: qwen3-coder:30b specialists
# first (1 cold load shared across 7), then abliterated:27b (scribe),
# then abliterated:35b (reaper).

set -uo pipefail

# Source nvm so `node` is on PATH even when invoked from a non-interactive
# WSL shell. Without this the previous run hit os-error-2 because GNU
# `timeout` couldn't find `node` in /usr/bin. See reference_claudeclaw_paths
# memory: nvm doesn't auto-source in non-interactive login shells.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
fi

REPO="/home/gcruise/repos/claudeclaw-os"
DB="$REPO/store/claudeclaw.db"
NODE_BIN="$(command -v node || echo node)"
CLI="$NODE_BIN $REPO/dist/specialist-cli.js"
TS="$(date +%Y%m%d-%H%M%S)"
REPORT="$REPO/store/bakeoff-v4-${TS}.md"

cd "$REPO" || { echo "cannot cd to $REPO" >&2; exit 1; }

# ── Ground-truth precomputation ─────────────────────────────────────────
# Compute the real answer for each test using bash directly. The specialist
# PASSES only if its response contains the corresponding value.

GT_README_FIRSTLINE="$(head -n 1 README.md 2>/dev/null | tr -d '#' | xargs)"
GT_SPECIALISTS_LINES="$(wc -l < src/specialists.ts 2>/dev/null)"
# Use the model field from /api/health as the truth substring rather than
# the entire JSON. Reason: sleuth's job is to fetch the endpoint and report
# results; the model may verbatim-dump or summarize, both are acceptable as
# long as it actually ran the curl. A substring like "claude-opus-4-7" is
# present in any honest report and absent from any fabrication.
GT_HEALTH_RAW="$(curl -s "http://127.0.0.1:3141/api/health?token=${DASHBOARD_TOKEN:-}" 2>/dev/null)"
GT_HEALTH="$(echo "$GT_HEALTH_RAW" | python3 -c "import json,sys; print(json.load(sys.stdin).get('model','?'))" 2>/dev/null)"
GT_PORT_COUNT="$(ss -tln 2>/dev/null | tail -n +2 | wc -l)"
GT_HIVE_ROWS="$(sqlite3 "$DB" 'select count(*) from hive_mind' 2>/dev/null)"
# Service-up check via process count instead of systemctl --user.
# systemctl --user requires D-Bus auth which fails inside claw's user-namespace
# sandbox (SO_PEERCRED breaks under UID remapping); even with
# CLAWD_SANDBOX_FILESYSTEM_MODE=off the namespace breaks bus auth.
# ss + awk pipelines also confuse the model. pgrep -c is the simplest
# integer-output sysadmin check.
GT_SERVICE="$(pgrep -c -f 'dist/index.js' 2>/dev/null)"
GT_DB_BYTES="$(stat -c %s "$DB" 2>/dev/null)"
# Cipher's bake-off task uses a pure compute (no file refs) to sidestep
# qwen3-coder:30b's "let me git_diff first" reflex that fires on any task
# mentioning a path. Pure compute keeps the spec on-role (cipher = data
# crunching) without triggering the path-bait. 2^20 = 1048576.
GT_CIPHER_COMPUTE='1048576'
GT_LAST_HASH="$(git -C "$REPO" log -1 --pretty=%h 2>/dev/null)"
GT_TS_FILE_COUNT="$(find src -name '*.ts' -type f 2>/dev/null | wc -l)"

# ── Report header ───────────────────────────────────────────────────────
{
  echo "# Bake-off v4 - strict verification (model-swap pivot)"
  echo ""
  echo "Run at: $(date -Iseconds)"
  echo ""
  echo "Strict pass criteria: \`hive_mind.artifacts.toolCalls >= 1\` AND output contains ground-truth value."
  echo ""
  echo "## Ground truth (computed by bash before any specialist runs)"
  echo ""
  echo '```'
  echo "README first line:        $GT_README_FIRSTLINE"
  echo "src/specialists.ts lines: $GT_SPECIALISTS_LINES"
  echo "/api/health response:     $GT_HEALTH"
  echo "ss -tln line count:       $GT_PORT_COUNT"
  echo "hive_mind row count:      $GT_HIVE_ROWS"
  echo "service is-active:        $GT_SERVICE"
  echo "claudeclaw.db bytes:      $GT_DB_BYTES"
  echo "git HEAD short hash:      $GT_LAST_HASH"
  echo "src/**/*.ts file count:   $GT_TS_FILE_COUNT"
  echo '```'
  echo ""
  echo "---"
  echo ""
} > "$REPORT"

# ── Helper: run a specialist test and verify ────────────────────────────
#
# Args: $1=callsign  $2=task  $3=ground_truth_value  $4=task_preview_substr
#       $5=test_label
#
# Captures stdout from the CLI, then queries hive_mind for the row matching
# task_preview_substr and reads toolCalls. PASS if both pass; reasoned FAIL
# message otherwise. All runs are appended to the same markdown report.
run_test() {
  local callsign="$1"
  local task="$2"
  local truth="$3"
  local task_substr="$4"
  local label="$5"

  local start_unix
  start_unix=$(date +%s)
  echo "[bakeoff] ▶ $callsign · $label" >&2

  # Run the specialist. Timeout 8 minutes per test to account for cold model load.
  local out_file
  out_file="$(mktemp)"
  local err_file
  err_file="$(mktemp)"
  timeout 480 $CLI delegate "$callsign" "$task" >"$out_file" 2>"$err_file"
  local exit_code=$?

  local response
  response="$(cat "$out_file")"
  local stderr_meta
  stderr_meta="$(cat "$err_file")"

  # Fetch the most-recent hive_mind row for this callsign post the start
  # timestamp, matching by task_substr. This handles concurrent runs by
  # picking the freshest match.
  local artifacts
  artifacts="$(sqlite3 "$DB" "
    SELECT artifacts FROM hive_mind
    WHERE agent_id='specialist:$callsign'
      AND action='specialist-delegate-claw'
      AND created_at >= $start_unix
      AND artifacts LIKE '%${task_substr//\'/\'\'}%'
    ORDER BY id DESC LIMIT 1;
  " 2>/dev/null)"

  local tool_calls
  tool_calls="$(echo "$artifacts" | python3 -c "
import json,sys
try:
    a = json.loads(sys.stdin.read() or '{}')
    print(a.get('toolCalls', -1))
except Exception:
    print('-1')
" 2>/dev/null)"

  local model_used
  model_used="$(echo "$artifacts" | python3 -c "
import json,sys
try:
    a = json.loads(sys.stdin.read() or '{}')
    print(a.get('model', '?'))
except Exception:
    print('?')
" 2>/dev/null)"

  local duration_ms
  duration_ms="$(echo "$artifacts" | python3 -c "
import json,sys
try:
    a = json.loads(sys.stdin.read() or '{}')
    print(a.get('durationMs', 0))
except Exception:
    print('0')
" 2>/dev/null)"

  # Two-pronged verification.
  local has_tool_call="no"
  if [ -n "$tool_calls" ] && [ "$tool_calls" -ge 1 ] 2>/dev/null; then
    has_tool_call="yes"
  fi

  # Filter pino log noise out of stdout before substring-matching. The CLI
  # writes some diagnostic lines to stdout that begin with a timestamp like
  # "[22:48:19.580]" or are indented continuations like "    chatId:". Those
  # leaked into truth-matching in v4's first run and caused two false-positive
  # PASSes (archivist: durationMs:13676 matched "76"; sentinel: pino sandbox
  # status text contained "active"). Strip them before grep.
  local clean_response
  clean_response="$(echo "$response" | grep -vE '^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]+\]|^    [a-zA-Z_]+:|^\[[a-z]+\] model=')"

  local has_truth="no"
  if [ -n "$truth" ] && echo "$clean_response" | grep -qF "$truth"; then
    has_truth="yes"
  fi

  local verdict
  if [ "$has_tool_call" = "yes" ] && [ "$has_truth" = "yes" ]; then
    verdict="PASS"
  elif [ "$has_tool_call" = "yes" ] && [ "$has_truth" = "no" ]; then
    verdict="FAIL (ran tool but answer wrong)"
  elif [ "$has_tool_call" = "no" ] && [ "$has_truth" = "yes" ]; then
    verdict="FAIL (no tool call; answer matched ground truth from injected context only)"
  else
    verdict="FAIL (no tool call, wrong answer)"
  fi

  # Append to report.
  {
    echo "## $callsign - $label"
    echo ""
    echo "- model: \`$model_used\`"
    echo "- toolCalls: \`$tool_calls\`"
    echo "- durationMs: \`$duration_ms\`"
    echo "- exit: \`$exit_code\`"
    echo "- ground truth contained in output: \`$has_truth\`"
    echo "- **VERDICT: $verdict**"
    echo ""
    echo "**Prompt**"
    echo ""
    echo '```'
    echo "$task"
    echo '```'
    echo ""
    echo "**Ground truth expected**: \`$truth\`"
    echo ""
    echo "**Response (first 80 lines)**"
    echo ""
    echo '```'
    echo "$response" | head -n 80
    echo '```'
    echo ""
    echo "**CLI stderr (tail)**"
    echo ""
    echo '```'
    echo "$stderr_meta" | tail -n 5
    echo '```'
    echo ""
    echo "---"
    echo ""
  } >> "$REPORT"

  echo "[bakeoff]   $verdict  (toolCalls=$tool_calls, truth=$has_truth, ${duration_ms}ms)" >&2

  rm -f "$out_file" "$err_file"
}

# ── qwen3-coder:30b group (loaded once, cached across these 7) ──────────

run_test coder \
  "Run this exact bash pipeline and report ONLY the resulting integer: cat src/specialists.ts | wc -l. The pipeline is your literal task; do not call git_status, git_diff, ReadFile, read_file, or any other tool before bash." \
  "$GT_SPECIALISTS_LINES" \
  "cat src/specialists.ts | wc -l" \
  "cat src/specialists.ts | wc -l"

run_test mercury \
  "Run via bash from inside the repo root: find src -name '*.ts' -type f | wc -l. Report ONLY the integer. Run the command, do not paste it." \
  "$GT_TS_FILE_COUNT" \
  "find src -name '*.ts'" \
  "src TypeScript file count"

run_test sleuth \
  "Run via bash: curl -s 'http://127.0.0.1:3141/api/health?token=${DASHBOARD_TOKEN:-}'. Read the JSON it returned and report the value of the \"model\" field. Do not invent or guess; if curl errors, say so." \
  "$GT_HEALTH" \
  "curl -s 'http://127.0.0.1:3141/api/health" \
  "dashboard /api/health model field"

# Recompute hive_mind row count immediately before archivist runs - the table
# grows during the bake-off itself (each specialist writes ~1 row), so the
# script-start ground truth would be stale by the time archivist queries.
GT_HIVE_ROWS="$(sqlite3 "$DB" 'select count(*) from hive_mind' 2>/dev/null)"
run_test archivist \
  "Run via bash: sqlite3 store/claudeclaw.db 'select count(*) from hive_mind'. Report ONLY the integer the DB returned. Run the query yourself." \
  "$GT_HIVE_ROWS" \
  "sqlite3 store/claudeclaw.db" \
  "hive_mind row count (recomputed pre-test)"

run_test sentinel \
  "Run this exact bash command and report ONLY the resulting integer: pgrep -c -f 'dist/index.js'. Run it via bash; do not call git_diff, read_file, or any other tool first." \
  "$GT_SERVICE" \
  "pgrep -c -f 'dist/index.js'" \
  "claudeclaw process count"

# DB file size also grows during the bake-off (WAL writes). Recompute.
GT_DB_BYTES="$(stat -c %s "$DB" 2>/dev/null)"
run_test cipher \
  "Run via bash: python3 -c 'print(2**20)'. Report ONLY the resulting integer. The literal command is your task; do not call git_status, git_diff, ReadFile, read_file, or any other tool before bash." \
  "$GT_CIPHER_COMPUTE" \
  "python3 -c 'print(2**20)'" \
  "python3 2^20 compute"

run_test atlas \
  "Run via bash: git -C /home/gcruise/repos/claudeclaw-os log -1 --pretty=%h. Report the 7-char short hash of HEAD. Run the command, do not narrate." \
  "$GT_LAST_HASH" \
  "git -C /home/gcruise/repos/claudeclaw-os log -1 --pretty=%h" \
  "git HEAD short hash"

# ── abliterated:27b (scribe) ────────────────────────────────────────────

run_test scribe \
  "Run via bash from the repo root: head -n 1 README.md. Then report that exact first line of the README (it is a top-level heading). Run the read; do not invent." \
  "$GT_README_FIRSTLINE" \
  "head -n 1 README.md" \
  "README first line"

# ── abliterated:35b (reaper) ────────────────────────────────────────────
# KNOWN LIMITATION: abliterated qwens do not reliably emit OpenAI-compat
# tool_calls. This test is expected to FAIL; included for parity.

run_test reaper \
  "Run via bash: ss -tln | tail -n +2 | wc -l. Report ONLY the integer (count of listening TCP sockets). Run the command, do not narrate." \
  "$GT_PORT_COUNT" \
  "ss -tln" \
  "listening TCP socket count"

# ── Summary ─────────────────────────────────────────────────────────────
{
  echo "## Summary"
  echo ""
  echo "Generated $(date -Iseconds)"
  echo ""
  PASS_COUNT=$(grep -c '\*\*VERDICT: PASS\*\*' "$REPORT" || true)
  FAIL_COUNT=$(grep -c '\*\*VERDICT: FAIL' "$REPORT" || true)
  echo "- PASS: $PASS_COUNT"
  echo "- FAIL: $FAIL_COUNT"
  echo ""
  echo "Reaper FAIL is expected per known limitation (abliterated qwens unreliable for tool calls)."
} >> "$REPORT"

echo "" >&2
echo "[bakeoff] done -> $REPORT" >&2
echo "$REPORT"
