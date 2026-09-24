I found a conflict worth flagging before I write the plan.

**What's in the repo:** `.gitignore` explicitly excludes `.cursor/settings.json` (Cursor is the editor already partly wired in via tracked `.cursor/hooks.json` and `.cursor/mcp.json`). History shows `.cursor/mcp.json` was *removed* from `.gitignore` and committed once it became shared config — but `.cursor/settings.json` was deliberately left ignored. There's also `.claude/settings.local.json`, explicitly commented as "Per-user Claude Code settings (personal permissions live here, NOT in the shared settings.json)". No `.vscode/settings.json` exists anywhere in history.

**The problem:** the task ("check in the personal editor settings file so everyone starts from the same config") is the opposite of what this repo currently does on purpose — personal editor prefs are kept local, and a *shared* baseline is achieved via `.prettierrc`, `eslint.config.js`, `tsconfig.json` instead. Also, no `.cursor/settings.json` file currently exists in this worktree, so there's nothing concrete to commit yet.

Before I write the plan, which do you actually want?

1. **Un-ignore and commit `.cursor/settings.json` as-is** — whatever personal Cursor prefs you currently have (you'd need to supply/create the file), accepting it may contain personal/local values.
2. **Create a new curated shared config** (e.g. `.cursor/settings.json` with just team-relevant settings — format-on-save, tab width, etc. — matching what `.prettierrc`/`eslint.config.js` already enforce) and keep truly personal overrides in a still-gitignored local file.
3. Something else — a different editor/file than `.cursor/settings.json`?
