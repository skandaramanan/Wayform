# plan_brief recall benchmark

```
node eval/brief-recall/run.mjs [case-id]
```

One `plan_brief` call per case against the **deployed** gateway. Each case is a
task whose correct design depends on a specific recorded fact; the only thing
measured is whether the brief put that fact in front of the agent. No LLM
judge, no agent sessions, seconds per run.

This exists because the bake-off costs ten headless sessions, is
length-confounded, and has four of five cases at ceiling — one free parameter
for seven candidate strategies.

## Results

| build | canon | normal | total |
|---|---|---|---|
| before the canon dump (2026-09-21, v`4307bdd2`) | 2/8 | — | **2/8** |
| with the canon dump (v`edec20b5`) | 8/8 | 1/3 | **9/11** |

**Read the `normal` column, not the total.** The brief now dumps every canon
fact under the cap, so any canon case is trivially a hit — those eight cases
are a regression guard (they fail if canon is ever turned back into a
query-ranked top-N, which is the bug the dump exists to fix), not a measure of
retrieval. The normal-tier cases are the live signal.

## What it cannot tell you

Whether the agent *uses* what it was shown. Recall is necessary, not
sufficient. That question needs the bake-off, or a plan-level check.

## Adding a case

Pick a fact a plausible task would violate if the agent hadn't seen it, and
write the prompt the way someone would actually ask — **not** in the fact's own
vocabulary. A case whose prompt shares the fact's rare terms measures nothing.
