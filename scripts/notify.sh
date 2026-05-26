#!/bin/bash
# Send a mid-task status message to BOTH Telegram and the dashboard chat
# in one call. Routes through the dashboard's /api/notify endpoint, which
# fans out to: conversation_log (so dashboard history persists), the SSE
# chat event bus (so open dashboards update live), and Telegram (so the
# user sees it on their phone).
#
# Usage: notify.sh "message text"
# Reads DASHBOARD_PORT, DASHBOARD_TOKEN, TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID
# from .env in the project root. Falls back to direct Telegram delivery if
# the dashboard endpoint is unreachable (service down, etc).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
MESSAGE="$1"

if [ -z "$MESSAGE" ]; then
  echo "notify.sh: message argument required" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "notify.sh: .env not found at $ENV_FILE" >&2
  exit 1
fi

read_env() {
  grep -E "^${1}=" "$ENV_FILE" | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'"
}

DASHBOARD_PORT=$(read_env DASHBOARD_PORT)
DASHBOARD_TOKEN=$(read_env DASHBOARD_TOKEN)
TG_TOKEN=$(read_env TELEGRAM_BOT_TOKEN)
CHAT_ID=$(read_env ALLOWED_CHAT_ID)

# Preferred path: unified endpoint fans out to all three sinks.
if [ -n "$DASHBOARD_PORT" ] && [ -n "$DASHBOARD_TOKEN" ]; then
  RESP=$(curl -s -m 5 -o /dev/null -w "%{http_code}" \
    -X POST "http://127.0.0.1:${DASHBOARD_PORT}/api/notify?token=${DASHBOARD_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$(jq -cn --arg m "$MESSAGE" '{message:$m}' 2>/dev/null || printf '{"message":%s}' "$(printf '%s' "$MESSAGE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" 2>/dev/null)
  if [ "$RESP" = "200" ]; then
    exit 0
  fi
fi

# Fallback path: dashboard unreachable — send to Telegram directly so the
# user still sees the message. Dashboard mirror is lost in this case.
if [ -n "$TG_TOKEN" ] && [ -n "$CHAT_ID" ]; then
  curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    -d chat_id="${CHAT_ID}" \
    -d text="${MESSAGE}" \
    -d parse_mode="HTML" > /dev/null
  echo "notify.sh: dashboard endpoint unreachable, sent direct to Telegram only" >&2
  exit 0
fi

echo "notify.sh: no delivery channel available" >&2
exit 1
