#!/bin/bash
# SessionStart hook: Auto-start RAG session and inject env vars.
# Reads config from .mcp.json, writes RAG_SESSION_ID to $CLAUDE_ENV_FILE.
# On any failure: exits 0 silently (fallback: ensureSession() in MCP middleware).

set -euo pipefail

MCP_JSON="$CLAUDE_PROJECT_DIR/.mcp.json"
if [[ ! -f "$MCP_JSON" ]]; then
  exit 0
fi

# Extract RAG config from .mcp.json
RAG_API_URL=$(python3 -c "
import json, sys
try:
    c = json.load(open('$MCP_JSON'))
    print(c['mcpServers']['rag']['env'].get('RAG_API_URL', 'http://localhost:3100'))
except Exception:
    print('http://localhost:3100')
" 2>/dev/null)

RAG_API_KEY=$(python3 -c "
import json, sys
try:
    c = json.load(open('$MCP_JSON'))
    print(c['mcpServers']['rag']['env'].get('RAG_API_KEY', ''))
except Exception:
    print('')
" 2>/dev/null)

PROJECT_NAME=$(python3 -c "
import json, sys
try:
    c = json.load(open('$MCP_JSON'))
    print(c['mcpServers']['rag']['env'].get('PROJECT_NAME', 'default'))
except Exception:
    print('default')
" 2>/dev/null)

# Start session
RESPONSE=$(curl -s -m 5 -X POST "$RAG_API_URL/api/session/start" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAG_API_KEY" \
  -H "X-Project-Name: $PROJECT_NAME" \
  -d "{\"projectName\":\"$PROJECT_NAME\",\"initialContext\":\"auto-started by SessionStart hook\"}" \
  2>/dev/null || echo "")

if [[ -z "$RESPONSE" ]]; then
  exit 0
fi

# Parse session ID
SESSION_ID=$(echo "$RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    sid = d.get('session', {}).get('sessionId', '') or d.get('sessionId', '')
    print(sid)
except Exception:
    print('')
" 2>/dev/null || echo "")

# Inject env vars into Claude Code session
if [[ -n "$SESSION_ID" && -n "${CLAUDE_ENV_FILE:-}" ]]; then
  echo "export RAG_SESSION_ID=$SESSION_ID" >> "$CLAUDE_ENV_FILE"
  echo "export RAG_PROJECT_NAME=$PROJECT_NAME" >> "$CLAUDE_ENV_FILE"
  echo "export RAG_API_URL=$RAG_API_URL" >> "$CLAUDE_ENV_FILE"
  echo "export RAG_API_KEY=$RAG_API_KEY" >> "$CLAUDE_ENV_FILE"
fi

exit 0
