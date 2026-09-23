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

| build | canon | normal | negative | total |
|---|---|---|---|---|
| before the canon dump (2026-09-21, v`4307bdd2`) | 2/8 | — | — | **2/8** |
| with the canon dump (v`edec20b5`) | 8/8 | 1/3 | — | **9/11** |
| 3 normal cases (2026-09-22, v`aee1a440`) | 8/8 | 2/3 | — | **10/11** |
| **18 normal + 3 negative cases (2026-09-23)** | 8/8 | **9/18** | **0/3** | **17/29** |

**Read the `normal` and `negative` columns.** The brief dumps every canon fact
under the cap, so a canon case is trivially a hit — those eight are a
regression guard against canon ever being turned back into a query-ranked
top-N, not a measure of retrieval.

Two things the wider set exposed that 3 cases could not:

- **Normal-tier recall is 50%, not 67%.** Half the binding facts a real task
  depends on never reach the brief.
- **Every negative control fails.** On prompts where nothing recorded binds
  ("bump the copyright year in LICENSE"), the brief still returns 10–11
  query-matched facts. τ is a floor and `BRIEF_MAX_FACTS` fills to it, so the
  brief pads rather than saying it has nothing. Note a relative-score cut was
  already falsified as the fix (it keeps 12/12 on a flat list and guts the
  strong cases), so this needs a different answer.

## What it cannot tell you

Whether the agent *uses* what it was shown. Recall is necessary, not
sufficient. That question needs the bake-off, or a plan-level check.

## Adding a case

Pick a fact a plausible task would violate if the agent hadn't seen it, and
write the prompt the way someone would actually ask — **not** in the fact's own
vocabulary. A case whose prompt shares the fact's rare terms measures nothing.
