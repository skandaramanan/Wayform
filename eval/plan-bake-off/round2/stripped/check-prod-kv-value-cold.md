# Look up a key in the production KV store

## Context
The gateway persists routing/session/cache state in a Cloudflare Workers KV
namespace bound as `ROUTING` (and `OAUTH_KV`, currently the same namespace id
`799c559402d6472993dc63ed26b0fd5e` — see `gateway/wrangler.toml`). Locally,
`wrangler` reads/writes a persisted on-disk KV store by default; against
Cloudflare it reads the real namespace when given `--remote`. The task is to
look up a key's current value in the **production** namespace, using the same
tool/workflow already used to check it locally — no new code.

## Goal
Read the current value of an arbitrary key from the production `ROUTING` KV
namespace, using the project's existing tooling (`wrangler`, already a
`devDependency` in `gateway/package.json`).

## Approach
Ladder check: this is a native-platform-feature case (rung 4) — `wrangler kv
key get` already does exactly this, and already supports switching between
local persisted storage and the real remote namespace via `--remote`/`--local`.
No script, wrapper, or repo code is needed; writing one would just be a less
flexible reimplementation of the CLI flag that already exists.

The only difference between "check it on your machine" and "check it in
production" is the `--remote` flag (which requires being authenticated
against the Cloudflare account that owns the namespace). Run the command from
`gateway/` so it picks up `wrangler.toml`'s `[[kv_namespaces]]` binding.

## Checklist

1. **Auth**: confirm Cloudflare auth is set up — `npx wrangler whoami` (from
   `gateway/`). If not logged in, `npx wrangler login`, or set
   `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` for a non-interactive
   token. Uses the account that owns namespace id
   `799c559402d6472993dc63ed26b0fd5e`.
2. **Local check** (baseline, same as always): from `gateway/`,
   `npx wrangler kv key get "<key>" --binding=ROUTING --local --text`
   — reads the on-disk persisted store used by `wrangler dev`.
3. **Production check**: same command with `--remote` instead of `--local`:
   `npx wrangler kv key get "<key>" --binding=ROUTING --remote --text`
   — reads the live namespace the deployed Worker uses.
4. If the key was written as JSON (most `ROUTING` values are, e.g. via
   `env.ROUTING.put(key, JSON.stringify(...))` in `gateway/src/*.ts`), pipe
   through `jq` to pretty-print, or drop `--text` to see the raw bytes.
5. No files change in this repo — this is a read-only ops command, not a
   code change. (Optional, only if this becomes a recurring need: add a
   one-line `kv:get` script to `gateway/package.json` that wraps
   `wrangler kv key get --binding=ROUTING "$@"`, letting the caller add
   `--local`/`--remote` — skip unless actually needed more than once.)

## Files touched
None. (Optional `gateway/package.json` script only if step 5's "recurring
need" condition is met — not part of this plan's scope.)

## Verification
- Run the `--local` and `--remote` commands above for a key known to exist
  in both (or a key you just wrote with `wrangler kv key put ... --local`)
  and confirm `--local` returns your local value while `--remote` returns
  whatever production currently holds — proving the two flags are hitting
  different stores and `--remote` is really production, not a cached/local
  copy.
- `npx wrangler kv key get --help` (from `gateway/`) to confirm flag names
  haven't changed for the installed `wrangler` version (`gateway/package.json`
  currently pins `^4.112.0`; this environment resolved `4.136.3`).

## Skipped
- A wrapper script or repo tooling around this — `wrangler` already covers
  it in one command; add one only if this lookup becomes frequent enough to
  be worth a `package.json` script.
