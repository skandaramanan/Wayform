No AskUserQuestion tool is available here, so I'll ask directly.

What's the underlying friction you're trying to remove? A couple of ways this could be solved safely, without a shared static secret:

1. **Auto-provision a per-user token on first connect** — new integration hits the gateway with no `Authorization` header, gets redirected into the existing OAuth install flow (which already exists in `gateway/src/setup.ts`), and comes back with its own per-user Bearer token. Zero manual setup, but each integration still gets a real, revocable, tenant-scoped identity.
2. **A one-line CLI command that mints and injects the token automatically** (e.g. `wayform init --remote` already writes config — maybe it's missing a step that fetches/writes the token itself instead of asking the user to paste one, using `src/token.ts` / `oauth-session.ts`).
3. Something else — maybe "fixed default header" means a header *name*/*format* convention, not a fixed *value*, and I'm misreading the ask.

Which of these (or something else) matches what you actually need? I don't want to plan a hardcoded shared credential — that's the exact pattern this repo tore out already (`531d1e65#1xlo37b`, the WEBHOOK_SECRET post-mortem in `tenancy.ts`, the `mlk_` token purge).