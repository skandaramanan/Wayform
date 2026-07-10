# Metrics instrumentation — design

Status: Approved (ready for implementation planning)
Date: 2026-07-03
Phase: 1 (the 4-week reliance test — instrumentation)

## Purpose

Instrument the read and write loop so the 4-week reliance test is measurable. The
success signal of the test is a human judgment — *a collaborator stops re-explaining
a decision because they trust it is already in the shared space* — and stays a manual
weekly tally. This workstream produces only the **auto-capturable half**: an append-only
event log of every context read and write, per author, in the shared context repo, so
the team can tally reads/writes weekly with `jq`/`grep`.

This is Phase 1 step 7 of the roadmap ("instrument metrics.jsonl read-rate"). It does
NOT touch usage/reliance friction (the thing the test measures) and adds no onboarding
friction.

## Why instrument at the store choke point, not the hook

Reads and writes physically happen in specific places:

- **Reads** funnel through `ContextStore.read()`, called from two callers:
  - `src/hook.ts` — the guaranteed SessionStart injection (the reliable path).
  - `src/index.ts` `read_context` MCP tool — model-invoked; the *only* read path on
    Claude Desktop.
- **Writes** happen in exactly one place: `src/index.ts` `write_context` MCP tool
  (`ContextStore.write()`). The Stop hook does **not** write — it only prints a review
  prompt; the model performs the actual write as an MCP call.

Consequence: instrumenting *hook fires* would capture **zero writes** (every write is an
MCP fire) and a Stop-hook fire would only record "we nudged," not "a decision was saved."
So instrumentation lives at the read/write call sites, tagged with the source
(`hook` | `mcp`) that only the caller knows. This captures Desktop too (MCP-only, no hooks).

## Architecture

### New module: `src/metrics.ts` (neutral core, no vendor logic)

```
recordMetric(cfg, { source, event, project, total? }): Promise<void>
```

- Appends **one JSON line** to `metrics/<slug(author)>.jsonl` in the context-repo working
  tree (`cfg.repoPath`). `mkdir -p` the `metrics/` dir on demand.
- Pure **local append** — no git, no network.
- **Fail-open, unconditionally**: every error (unwritable path, bad config, serialization
  failure) is caught and swallowed; the function never rethrows. Metrics must never break
  or slow a read/write — the same posture as the read hook. A metric we fail to record is
  invisible; a metric that breaks a session poisons the exact signal we are measuring.

### Instrumentation call sites (3, each a thin post-op call)

- `src/hook.ts` after a successful `store.read` → `recordMetric(source:'hook',
  event:'read')`. No flush.
- `src/index.ts` `read_context` after a successful read → `recordMetric(source:'mcp',
  event:'read')`. No flush.
- `src/index.ts` `write_context` after a successful write → `recordMetric(source:'mcp',
  event:'write')`, **then flush**.

Each call is wrapped so a metrics failure cannot affect the read/write result returned to
the caller (belt-and-suspenders with `recordMetric`'s own internal fail-open).

### Flush: `store.flushMetrics()` (new store method)

- Runs **inside the store's existing per-clone serialize mutex** so metrics git never
  races the entry git in the same clone.
- `git add metrics/<author>.jsonl` → commit `"metrics: sync"` → **best-effort push**
  (swallow errors, mirroring `GitRepo.selfHealPush`).
- Called **only after writes**. It commits *all* accumulated lines — every read since the
  last write plus this write — in a single commit. This is the "append local, flush on
  next write" contract: reads never touch git; the next write carries their lines to the
  remote. Eventual sync is acceptable for a weekly-check test.

## Record schema

One JSON object per line (`metrics/<author>.jsonl`):

```json
{"ts":"2026-07-03T14:22:01.900Z","author":"Skanda","source":"hook","event":"read","project":"memorylayer","total":11}
```

| field     | meaning |
|-----------|---------|
| `ts`      | ISO-8601 timestamp of the event |
| `author`  | `cfg.author` (already the git-commit attribution) |
| `source`  | `hook` \| `mcp` — separates *guaranteed* injection from *opportunistic* model reads; a read beyond the forced injection is itself an engagement signal |
| `event`   | `read` \| `write` |
| `project` | the shared project/space name |
| `total`   | reads only: entry count returned by `store.read` (cheap store-depth signal). Omitted on writes |

`total` is reads-only to avoid overloading one field with two types (a count vs. an id).
A write line is fully identified by `author` + `ts` + `event:"write"`; the entry id is
already recorded in the context entry itself, so it is not duplicated here.

No payloads, no PII beyond the author name that is already in every git commit.
Per-author file → two writers never touch the same file → no merge conflicts (same reason
context entries are per-author).

## Storage location

`metrics/` is a new top-level directory in the **context** repo (`~/.memorylayer/
context-store`), committed and pushed like context entries. Everyone's reads/writes land
in one git-merged log tallyable across the whole team. It must **not** be gitignored.
`init` needs no changes — the directory auto-creates on the first record, so there is zero
added onboarding friction.

## Error posture summary

- `recordMetric`: fail-open, swallow all errors, never rethrow.
- `flushMetrics`: best-effort push, swallow errors (unpushed lines ride the next write, or
  a later `selfHealPush`).
- Reads never do git. The fail-open, latency-critical read hook is untouched on the hot path.

## Testing

- `test/metrics.test.mjs`:
  - `recordMetric` appends a well-formed JSON line parseable by `JSON.parse`.
  - `metrics/` directory is auto-created when absent.
  - Unwritable path / bad config → **no throw** (fail-open contract).
  - Multiple appends accumulate as multiple lines.
- Integration (throwaway git repo):
  - A read appends a `read` line with the correct `source`.
  - A write appends a `write` line, and `flushMetrics` commits `metrics/<author>.jsonl`.
- All 71 existing tests stay green — `store.read`/`store.write` public signatures are
  unchanged (instrumentation is added at callers + a new store method).

## Scope

**In scope:** `src/metrics.ts`, 3 instrumentation call sites, `store.flushMetrics()`,
per-author jsonl in the shared context repo, tests.

**Explicitly NOT in scope (scope-creep is the documented #1 failure mode):**

- No `memorylayer metrics` report/rollup command. Analyze the raw jsonl with `jq`/`grep`
  weekly. Add a command later only if the raw log proves annoying.
- No automatic re-explained detection. The re-explained tally and the reliance signal stay
  a **manual human tally** — that human judgment is what the test hinges on and is exactly
  the ~60–85% unreliable model-judgment path the project distrusts.
- No `sessionId` capture. Deferred: it would enable a true reads-per-session denominator,
  but MCP reads have no session concept and Cursor's stdin shape is unverified, so it is
  partial and fiddly. Revisit only if a session-level denominator is needed.
- No new runtime dependencies. No changes to `init` or `hook-clients.ts`.

## Neutrality

`metrics.ts` is neutral core. The `source` tag is `hook`/`mcp`, not a vendor name. Nothing
is added to `src/hook-clients.ts`. A metric recorded from a Claude Code session is readable
from a Cursor/Codex tally and vice versa — same neutral store, same contract.
