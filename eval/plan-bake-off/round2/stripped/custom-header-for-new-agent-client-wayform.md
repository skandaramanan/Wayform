I looked into this before drafting a plan, and the task as stated runs into a decision this codebase already made — worth flagging before I write anything.

**What I found:**
- Every existing client (`cursor`, `claude`, `codex`, `devin`, `antigravity` — the full `RemoteClient` union in `src/init-remote.ts`) is wired with OAuth/DCR, URL-only, **no header, no secret in any file**. `mergeAntigravityRemoteMcp` (the most recently added client) even carries the comment "DCR OAuth: URL only, no headers."
- This wasn't an oversight. Commit `97a9af4` (Jul 11) once wrote a literal `Authorization: Bearer <token>` header into Codex's config. Commit `b804915` "auth hardening" (Aug 30) deliberately ripped that out in favor of OAuth 2.1 + GitHub DCR — "Cursor/Codex configs are URL-only... no member tokens." That's also the date of the decision: **"a static header disables the client's OAuth fallback."**
- The whole onboarding path (`init-env.ts`, `init-configs.ts`) is now explicitly "secret-free" / "credential-free" by design — a static shared secret in a config file is the exact pattern that was removed.

**Two things I need before planning:**
1. Which client do you mean by "the newest coding-agent client"? All five known ones already have OAuth-based wiring, so there's no gap to fill under the current pattern — unless you mean a client not yet in `RemoteClient` at all (in which case it should get the same OAuth treatment as `antigravity`, not a header).
2. Do you actually want a static shared-secret header (reintroducing the pre-`b804915` pattern, which would disable that client's OAuth fallback per the decision), or did you mean "wire it up" in the OAuth-only style every other client uses?

I'd default to declining the static-header approach and extending the existing OAuth pattern instead — but that's a real behavior change from what you asked, so I want your call before I write the plan.
