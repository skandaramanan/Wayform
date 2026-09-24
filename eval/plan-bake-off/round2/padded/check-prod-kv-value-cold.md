# Look up a key in the production KV store

## Context
The gateway persists its routing, session, and cache state in a Cloudflare Workers KV namespace that is bound as `ROUTING`. A second binding, `OAUTH_KV`, currently points at the very same namespace id, `799c559402d6472993dc63ed26b0fd5e`, as documented in `gateway/wrangler.toml`. By default, `wrangler` reads from and writes to a persisted on-disk KV store when it runs locally. When it is given the `--remote` flag, it instead reads the real namespace hosted on Cloudflare. The task is to look up the current value of a key in the **production** namespace. It should use the same tool and workflow already used to check the value locally, and it requires no new code.

## Goal
The goal is to read the current value of an arbitrary key from the production `ROUTING` KV namespace. This should be done with the project's existing tooling, namely `wrangler`, which is already declared as a `devDependency` in `gateway/package.json`, so nothing new has to be installed or introduced.

## Approach
Applying the ladder check, this is a native-platform-feature case (rung 4). The command `wrangler kv key get` already does exactly what is needed, and it already supports switching between local persisted storage and the real remote namespace through the `--remote` and `--local` flags. Because of this, no script, wrapper, or repo code is needed. Writing any of these would only produce a less flexible reimplementation of a CLI flag that already exists.

The only difference between "check it on your machine" and "check it in production" is the `--remote` flag. Using that flag requires being authenticated against the Cloudflare account that owns the namespace. The command should be run from the `gateway/` directory, so that `wrangler` picks up the `[[kv_namespaces]]` binding declared in `wrangler.toml`.

## Checklist

1. **Auth**: Before anything else, confirm that Cloudflare authentication is set up by running `npx wrangler whoami` from `gateway/`. If you are not logged in, run `npx wrangler login`. Alternatively, for a non-interactive setup, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to use a token. Whichever route you take, the credentials must belong to the account that owns namespace id `799c559402d6472993dc63ed26b0fd5e`.
2. **Local check** (the baseline, same as always): from `gateway/`, run
   `npx wrangler kv key get "<key>" --binding=ROUTING --local --text`.
   This reads the on-disk persisted store that `wrangler dev` uses, so it shows what your local environment currently holds for the key.
3. **Production check**: Run the same command, but with `--remote` in place of `--local`:
   `npx wrangler kv key get "<key>" --binding=ROUTING --remote --text`.
   This reads the live namespace that the deployed Worker uses, so it shows what production currently holds for the key.
4. If the key was written as JSON, pipe the output through `jq` to pretty-print it, or drop `--text` to see the raw bytes. Most `ROUTING` values are written this way, for example via `env.ROUTING.put(key, JSON.stringify(...))` in `gateway/src/*.ts`.
5. No files change in this repo. This is a read-only ops command rather than a code change. As an optional extra, only if this becomes a recurring need, add a one-line `kv:get` script to `gateway/package.json` that wraps `wrangler kv key get --binding=ROUTING "$@"`, which lets the caller add `--local` or `--remote` as needed. Skip this unless the lookup is actually needed more than once.

## Files touched
None. The only possible exception is the optional `gateway/package.json` script, which applies only if step 5's "recurring need" condition is met. That script is not part of this plan's scope.

## Verification
- Run the `--local` and `--remote` commands above against a key known to exist in both stores, or against a key you just wrote with `wrangler kv key put ... --local`. Confirm that `--local` returns your local value while `--remote` returns whatever production currently holds. This shows that the two flags are hitting different stores, and that `--remote` is really reading production rather than a cached or local copy.
- Run `npx wrangler kv key get --help` from `gateway/` to confirm that the flag names have not changed for the installed `wrangler` version. Note that `gateway/package.json` currently pins `^4.112.0`, and this environment resolved `4.136.3`.

## Skipped
- A wrapper script or other repo tooling around this lookup is skipped. `wrangler` already covers the need in a single command, so a wrapper would add nothing today. Add one only if the lookup becomes frequent enough to justify a `package.json` script.
