# Scoring protocol for the plan bake-off

Two instruments, decided after an adversarial review of both (2026-09-22/23).
Neither alone is trustworthy here.

## Why the original scorecard was retired

Unblinded single-model preference scoring. Word-count delta rank-correlated
with the verdict 5/5. And "cited a decision the cold plan missed" became
mechanically 5/5 the moment the brief began dumping every standing rule, so
that column stopped measuring anything.

## 1. Pre-registered rubric — the cheap mechanical gate

Fix a **selection rule** (search terms, scoring formula, exclusions,
tie-breaks) derived from the recorded store and the repo code ONLY, write the
per-case checks, and `shasum -a 256` the file **before opening any plan**.
Then score pass / fail / not-applicable per check with a verbatim quote as
evidence, and keep a SEPARATE, UNSCORED list of anything significant the rubric
did not anticipate.

Honest limits, conceded after review:
- True blindness is impossible once anyone has read the plans. What the hash
  buys is *auditable non-discretion*, not blindness — never conflate them. The
  2026-09-23 run demonstrated the difference by **missing** the one fact the old
  README calls decisive (`6d411906#1mqe19j` did not match its fixed term list)
  and disclosing that rather than patching it.
- Low resolution: 35 checks over 5 cases left 30 of 70 cells N/A and only 6
  checks differing between arms.
- It only sees anticipated errors. The highest-value distinctions showed up in
  the unscored list, not the scored cells. That is why the unscored list is
  mandatory.
- Unweighted counting is itself a weighting choice: dropping four lexical-noise
  checks flipped two of the three non-tie cases.

Use it as a **regression gate**, written before outputs exist. It is the only
instrument that catches "both arms broke the same rule", which a comparative
judge scores as "no difference".

## 2. Blinded pairwise judge — the primary "which would you start from" verdict

- **Strip provenance, keep substance**, by a mechanical script with a published
  diff: HTML comments, tool/session preambles, title lines carrying phase
  numbers, save/postamble text, `inherits` blocks, fact ids
  (`[0-9a-f]{8}#[a-z0-9]{4,}`), provenance adjectives ("recorded decision" →
  "decision"), experiment references. Verify with a grep allowlist and a
  leak-canary call per plan.
- **Judge in an empty directory with no settings sources, no tools, no MCP** —
  user hooks inject text (this repo's own hooks inject the briefing, and a
  user-level plugin injected a "prefer minimal designs" instruction that would
  bias toward the leaner plan). Confirm with an environment canary.
- **Both orders, k=3 samples each.** A case counts as won only if the same arm
  wins the majority in BOTH orders; a preference that flips with order is not a
  preference.
- **Length control:** require the judge to name the single decisive design
  difference and quote it verbatim from each plan (<25 words), then classify it.
  Verdicts landing in `completeness_or_detail`, `clarity_or_presentation` or
  `substantially_same` count as ties by rule. Grep-verify every quote.
- **Calibration probe:** judge each of two plans against a padded twin of
  itself (+40% words, no new content). If the padded twin wins more than 2 of
  12, the judge is length-biased and the run is void.
- Team context = a frozen, time-filtered, hashed export of live decisions —
  NOT the brief's own selection, which would hide exactly the facts the brief
  missed and systematically favour the briefed arm.

## Standing caveat

Five cases with ONE generation per arm. Judge samples measure judge noise, not
generation variance, so even 5/5 is a direction, not a statistical result.
Before spending ~72 model calls re-judging this dataset, generate fresh plans
with more cases — otherwise the protocol is more precise than the data.
