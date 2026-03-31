#!/bin/bash
# Stop hook: End RAG session and trigger consolidation agent.
# Reads RAG_SESSION_ID injected by session-start.sh via $CLAUDE_ENV_FILE.
# On any failure: exits 0 silently (best-effort).

SESSION_ID="${RAG_SESSION_ID:-}"
API_URL="${RAG_API_URL:-http://localhost:3100}"
API_KEY="${RAG_API_KEY:-}"
PROJECT="${RAG_PROJECT_NAME:-default}"

if [[ -z "$SESSION_ID" ]]; then
  exit 0
fi

# End session with autoSaveLearnings — triggers consolidation agent server-side
curl -s -m 15 -X POST "$API_URL/api/session/$SESSION_ID/end" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Project-Name: $PROJECT" \
  -d "{\"projectName\":\"$PROJECT\",\"summary\":\"Session ended by Stop hook\",\"autoSaveLearnings\":true}" \
  >/dev/null 2>&1 || true

exit 0
