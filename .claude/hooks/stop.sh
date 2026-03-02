#!/bin/bash
# Stop hook: Remind to call remember() if edits were made
# Non-blocking reminder — does not prevent stopping.

echo "Session ending. If you made code changes, ensure remember() was called to save context."
exit 0
