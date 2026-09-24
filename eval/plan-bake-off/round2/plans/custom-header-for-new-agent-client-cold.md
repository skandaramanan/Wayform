I dug into the repo before drafting anything, and found a hard conflict with what's being asked.

**What "newest coding-agent client" resolves to:** `antigravity` — it's the last entry added to `RemoteClient` in `src/init-remote.ts:88`, wired via `mergeAntigravityRemoteMcp` in `src/init-configs.ts:310`.

**The conflict:** that function's own comment reads:

```
* Antigravity workspace MCP (`.agents/mcp_config.json`). Uses `serverUrl`
* per Google's schema. Not `~/.gemini/config/mcp_config.json` (global).
* DCR OAuth: URL only, no headers.
```

This isn't an oversight — it's the deliberate end state of this codebase's security posture:
- Every other client (`cursor`, `claude`, `codex`, `devin`) is wired the same way: URL only, OAuth for auth, **no token/secret ever written into a checked-in config file**.
- `.codex/config.toml` literally has the comment "URL + OAuth only; no member token."
- `src/init-remote.ts` says "No member token is written anywhere: selected clients run OAuth."
- `.gitleaks.toml` has custom rules (`mlk_`, `wfi_`) added specifically because of a **real incident** (2026-07-15) where a wayform member token leaked via a committed onboarding doc. The whole token-free-onboarding design exists to stop that from happening again.
- Even the GitHub Actions self-hoster path, which does use a static `MEMORYLAYER_TOKEN`, keeps it in encrypted repo secrets — never in a file that gets committed.

So "drop the shared secret into a custom HTTP header in its config file" for antigravity would mean writing a long-lived credential straight into `.agents/mcp_config.json`, which is one of the files `commitPaths()` tells the user to `git add` and commit for teammates to inherit — i.e., committing a secret to the repo, the exact failure mode this team already got burned by and explicitly engineered out.

Before I write a plan, I want to check: is there a reason antigravity specifically can't do OAuth (so a static header is the only option), or should this instead follow the existing pattern — wire antigravity through the same DCR-OAuth flow as the other four clients, no header, no secret in the file? If it's the latter, that's not really "drop a secret in a header" — it'd be closer to "antigravity already does this correctly, nothing to change" or a much smaller task (e.g., docs/README client list). Let me know which you actually want before I lock in a plan.