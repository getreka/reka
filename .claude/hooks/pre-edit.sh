#!/bin/bash
# PreToolUse hook: Enforce context_briefing before Edit/Write
# Checks if context_briefing or smart_dispatch was called in this session.
# Uses a session-level marker file.

MARKER="/tmp/.claude-rag-context-$$"

# If the tool being called IS context_briefing or smart_dispatch, set marker
TOOL_NAME="${CLAUDE_TOOL_NAME:-}"
if [[ "$TOOL_NAME" == *"context_briefing"* ]] || [[ "$TOOL_NAME" == *"smart_dispatch"* ]]; then
  touch "$MARKER"
  exit 0
fi

# For Edit/Write, check if marker exists (any context_briefing session marker)
if ls /tmp/.claude-rag-context-* 1>/dev/null 2>&1; then
  exit 0
fi

# No context loaded — warn (but don't block to avoid workflow disruption)
echo "Warning: No context_briefing/smart_dispatch called yet. Consider running it first for better code quality."
exit 0
