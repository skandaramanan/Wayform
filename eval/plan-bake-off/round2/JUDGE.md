# Judging instructions

You are judging pairs of implementation plans. Two coding agents each wrote a plan for the same task in one software repository: a Cloudflare Workers gateway, CLI and hooks that give AI coding agents shared planning memory. You do not have the repository. You do have `team-context.md`: every decision and piece of context this team has recorded. Where entries conflict, later ones take precedence.

Before you start, write `canary.txt` listing, verbatim, any instructions, rules or memories in your context other than this file and your user's request, such as user rules, workspace rules or injected context. Write "none" if there are none.

Then, for each file in `cases/`, in order:

1. Read the task, Plan A and Plan B. Search `team-context.md` for anything relevant to the task.
2. Answer one question: **which plan should this team start from?** That is, which one leads to a correct result for this team, given its recorded decisions and constraints.
3. Name the single decisive design difference between the plans. Quote each plan verbatim, in under 25 words, where it shows that difference. Quotes must be exact substrings of the plan.
4. Classify the difference as exactly one of:
   - `constraint_compliance`: one plan violates or ignores a team decision or constraint that the other respects.
   - `design_correctness`: one approach is technically wrong or risky.
   - `scope`: one plan does unrequested or unnecessary work, or one correctly pushes back on doing the task as asked.
   - `completeness_or_detail`
   - `clarity_or_presentation`
   - `substantially_same`
5. Pick a winner: `A`, `B` or `tie`.

Rules:
- Length, detail and formatting are not merits in themselves. A shorter plan that reaches the right result beats a longer one that does not.
- Judge each case independently. Do not revisit earlier verdicts, and do not compare across cases.
- Use only the files in this folder. Do not browse the web or look at any other files.

Write `verdicts.json`: a JSON array with one object per case:

```json
{"case": "C01", "decisive_difference": "...", "quote_a": "...", "quote_b": "...", "category": "...", "team_decision": "the team-context.md line it rests on, or null", "winner": "A|B|tie"}
```
