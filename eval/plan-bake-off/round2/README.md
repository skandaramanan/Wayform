# Plan bake-off, round 2

The question: when the brief shows the agent the decision that constrains a task, does the Wayform plan beat plain Claude Code's?

- `rubric.json` was fixed and hashed (`rubric.sha256`) before any plan existed. The hash is also timestamped in the store as entry 73ee892e.
- `gen.mjs` runs `claude -p` on Sonnet in plan mode for both arms, with the Agent tool disabled. The cold arm runs in a throwaway worktree with `.claude/` removed and no MCP. The Wayform arm calls plan_brief.
- `strip.mjs` removes arm provenance and logs every edit to `strip-diff.txt`. `pad.mjs` makes the padded calibration twins. `packet.mjs` builds two blinded judge packets (order 1, and order 2 with every pair swapped). `key.json` is the answer key.
- The judge runs in Cursor on a non-Claude model: open `packet-1` as the workspace and say "Follow JUDGE.md exactly." Then do the same for `packet-2` in a fresh chat.

**Batch 1 (2026-09-24):** the 5 "hit" cases, where the brief contained the binding fact. If Wayform doesn't win these, stop.

**Batch 2** (only if batch 1 shows a win): 3 misses and 2 negatives, `node gen.mjs add-date-formatting-lib,ci-build-on-free-tooling,commit-local-creds-file,neg-changelog-grammar-fix,neg-editorconfig`. Then re-run strip, packet and judging.
