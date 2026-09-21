# Phase 2 exit bake-off

`node eval/plan-bake-off/run.mjs [case-id]` → `out/<case>-cold.md` and
`out/<case>-wayform.md`. Requires the `claude` CLI and the wayform MCP server
configured for this repo, with `plan_brief` deployed to the gateway.

Read each pair — blind to the filename if you can — and answer one question per
case.

| Case | Which would you rather start from? | Cited a real decision the cold plan missed? | Contradicted a settled decision? |
|---|---|---|---|
| dispatch | **Wayform** | Yes | No |
| desktop-plan-view | **Wayform** (narrow) | Yes | No |
| outcome-capture | Tie | Yes | No |
| repo-map | **Wayform** | Yes | No |
| rbac | Tie | **No** | Yes — both arms |

**Gate:** Wayform wins or ties on ≥4 of 5, and cites a real decision the cold
plan missed on ≥3. **Result: 3 wins, 2 ties, 4/5 citations → PASSED**
(scored 2026-09-21 by Claude against the clean cold arm; founder confirmation
pending).

## A note on the two cleared `RUN INVALID` banners

The first leak detector keyed on the strings "fact id" and "plan #N". Those
appear in this repo's own source and schemas, so it flagged `outcome-capture`
and `repo-map` cold runs that were in fact clean: neither contains a store-only
fact id (`[0-9a-f]{8}#...`), and their "plan #11" traces to a comment in
`gateway/src/plan-brief.ts`. The banners were cleared on review and the
detector now keys on fact ids and briefing phrasing. **All five pairs are
valid.** Anyone re-reading these files should not treat the old banner text as
a live finding — it misled one reviewer already.

## Case notes

- **dispatch** — Cold designed a GitHub-issue bot that dispatches to Copilot and
  auto-ships on PR merge, which runs straight into the recorded decision that
  Wayform is *live in-agent, not a PR reviewer / merge-gate bot*. Wayform built
  `wayform dispatch <N>` on the existing `src/hook-clients.ts`, kept the plan in
  `building` because shipped means merged, inherited 5 fact ids and cut 5 as
  near-misses.
- **desktop-plan-view** — Near-identical architecture (`/mcp/api/plan` over the
  existing service layer, optimistic lock on `rev` not `version`). Wayform edges
  it by citing the decision that authorizes the REST route at Phase 3 and by
  staying on plan #5's Tauri stack; cold invented a local-server-plus-browser
  shell without knowing #5 exists.
- **outcome-capture** — Genuinely close. Cold's `violated: [fact ids]` on the
  ship event reuses `memory_feedback` with no new event type and is leaner.
  Wayform's `outcome` event matches plan #7's revert/hotfix intent and cites the
  forward-only lifecycle. Tie.
- **repo-map** — Cold produced a good design (`file:` tags in `fact_entities`,
  a fourth `fileRank` source) for work that was **deferred that same day**.
  Wayform found the deferral, gated its own plan on the bake-off outcome, and
  refused to build it. Knowing not to build something is the higher-value plan.
- **rbac — the miss.** Both arms put the viewer permission check in `toolsCall`
  in `mcp.ts`. The store holds `6d411906#1mqe19j`: *never put domain logic or
  policy checks in a transport.* `plan_brief` returned 12 facts for this prompt
  and that one was not among them; the Wayform arm concluded "inherits: none".
  Retrieval precision, not the missing repo map, is Phase 2's real gap.

  Note: in the **contaminated** first pass, the cold arm *did* get this right —
  the SessionStart briefing surfaced the service-layer decision that query-time
  retrieval missed. `renderBriefing` carries canon and recent decisions;
  `plan_brief` carries only query-matched facts. That asymmetry is the fix to
  try first.
