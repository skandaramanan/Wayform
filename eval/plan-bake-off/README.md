# Phase 2 exit bake-off

`node eval/plan-bake-off/run.mjs [case-id]` → `out/<case>-cold.md` and
`out/<case>-wayform.md`. Requires the `claude` CLI and the wayform MCP server
configured for this repo, with `plan_brief` deployed to the gateway.

Read each pair — blind to the filename if you can — and answer one question per
case.

| Case | Which would you rather start from? | Did the Wayform plan cite a real decision the cold one missed? | Did it contradict a settled decision? |
|---|---|---|---|
| dispatch | | | |
| desktop-plan-view | | | |
| outcome-capture | | | |
| repo-map | | | |
| rbac | | | |

**Gate:** Wayform wins or ties on ≥4 of 5, and cites a real decision the cold
plan missed on ≥3. Below that, Phase 2 is not done — fix the brief (or build
§2.1 repo routing) before Phase 3.
