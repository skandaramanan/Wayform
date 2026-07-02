#!/bin/bash
# MemoryLayer Stop-hook launcher — neutral.
#
# Usage: stop-review.sh <client>     # client: cursor | claude-code | raw
#
# Invoked ONLY by this repo's project-scoped Stop hook, so end-of-turn self-review
# fires only when working in THIS project. Wires the client's Stop event (end of every
# assistant turn), NOT SessionEnd (which is cleanup-only and cannot re-engage the model).
#
# Fail-open + loop-guard are guaranteed downstream in dist/stop-hook.js.
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$REPO_ROOT/.memorylayer-hook.env" ]; then
  set -a
  . "$REPO_ROOT/.memorylayer-hook.env"
  set +a
fi

export MEMORYLAYER_HOOK_CLIENT="${1:-claude-code}"
exec node "$REPO_ROOT/dist/stop-hook.js"
