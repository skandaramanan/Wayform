# Look up a key in the production KV store

## Context

This isn't a code change — it's a one-off operational read. Wayform's `plan_brief` for this project already has the exact answer settled from a prior incident (`aa391b54`, `730c0d14`): `wrangler kv key get`/`list`/`delete` default to the **local** dev simulator, and silently do nothing to production unless `--remote` is passed — no error, just the wrong store. That gotcha is the whole reason "the same way you'd check it on your machine" isn't literally correct: locally you run the command bare; against production you must add `--remote`.

Repo facts (`gateway/wrangler.toml`):
- Two KV bindings share one namespace: `ROUTING` and `OAUTH_KV`, both `id = 799c559402d6472993dc63ed26b0fd5e`.
- No wrapper script exists for this — it's a direct `wrangler` CLI call, run from `gateway/`.

## Approach

Run, from `gateway/`:

```bash
npx wrangler kv key get "<KEY>" --binding ROUTING --remote
```

(Swap `--binding ROUTING` for `--binding OAUTH_KV` if the key lives in the OAuth-grants side of that shared namespace, or use `--namespace-id 799c559402d6472993dc63ed26b0fd5e` directly — same store either way.)

No `ADMIN_SECRET` or other auth is needed to read production KV (`aa391b54#5ihrr8`). No files are touched; nothing is built or deployed.

## Open question

**Which key?** The task didn't name one. I'll ask before running anything.

## Checklist

- [ ] Get the key name from the user.
- [ ] Run `npx wrangler kv key get "<KEY>" --binding ROUTING --remote` from `gateway/` (confirm binding if the key is OAuth-related).
- [ ] Report the value back (or "not found" if `wrangler` returns nothing).

## Verification

The command's own output is the verification — `wrangler kv key get --remote` either prints the value or errors/returns empty if the key doesn't exist in production.
