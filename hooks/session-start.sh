#!/bin/bash
# MemoryLayer session-start read hook — neutral launcher.
#
# Usage: session-start.sh <client>     # client: cursor | claude-code | raw
#
# This is invoked ONLY by this repo's project-scoped hooks (.cursor/hooks.json,
# .claude/settings.json), so shared planning context is injected only when you're
# working in THIS project — never in unrelated Cursor/Claude Code sessions.
#
# User-specific config (identity, context repo URL) stays OUT of git: it is read
# from .memorylayer-hook.env (gitignored). See .memorylayer-hook.env.example.
#
# Fail-open is guaranteed downstream: dist/hook.js always prints a valid no-op and
# exits 0, so a bad read never blocks a session.
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$REPO_ROOT/.memorylayer-hook.env" ]; then
  set -a
  . "$REPO_ROOT/.memorylayer-hook.env"
  set +a
fi

export MEMORYLAYER_HOOK_CLIENT="${1:-cursor}"
exec node "$REPO_ROOT/dist/hook.js"
