# Plans live in Wayform (this repo only)
In this repo, Wayform (project "MemoryLayer") is the home for plans. This rule applies to this repo only: in other repos, superpowers keeps its default local plan files.
- superpowers:writing-plans (and any other plan or spec you write): save the plan with `create_plan(project="MemoryLayer", title, body, repo?, branch?, inherits=[fact ids it builds on])` instead of a local `docs/superpowers/plans/*.md` or `docs/plans/*.md` file. Tell the user the plan number (#N). Revise it with `edit_plan`; don't write a local copy.
- superpowers:brainstorming: save the approved design the same way, with `create_plan`.
- superpowers:executing-plans / subagent-driven-development: read the plan with `read_plan`. Call `transition_plan(to="active")` when the user approves it and `to="building", agent="claude-code"` when implementation starts. Record progress by editing the checklist with `edit_plan`.
- When the work merges: `transition_plan(to="shipped", commit_sha, decisions=[atomic facts, each with its because], supersedes=[fact ids they replace])`.
- If a new plan replaces an old one: `transition_plan(old, to="superseded", superseded_by=new)`.
- If the wayform MCP server is unavailable, fall back to the skill's default file path and say so.
