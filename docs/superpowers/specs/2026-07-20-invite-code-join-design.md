# Invite-code member self-minting (`/join`)

Date: 2026-07-20
Status: approved (Skanda, 2026-07-20)

## Problem

Every member token is minted by the operator via `POST /admin/members` and
hand-distributed — a serial 2-minute step per dev, and secret distribution is
the failure class behind both token-leak incidents and the iMessage
command-mangling bug. An 8-dev pilot team (Spear AI) makes this the onboarding
bottleneck.

Chosen scope (option 2 of 3 considered): the operator still registers each
space and mints one **invite code** per team; the leader forwards the code;
each dev self-mints their own member token from it. Full leader self-serve
(challenge-proof space registration) was explicitly deferred — it is additive
on top of this design and can land later without rework.

## Design

### Invite record (KV)

Key `invite:<sha256(code)>` in the existing ROUTING namespace (same
hashed-secret pattern as `member:` records). Value:

```json
{ "space", "owner", "repo", "installationId", "branch",
  "expiresAt", "usesLeft" }
```

Codes are `wfi_` + 32 random url-safe bytes (same generator as `newToken`,
different prefix). Defaults: **14-day expiry, 25 uses**. The invite carries
the full space binding so `/join` needs no other lookup.

### `POST /admin/invites` (ADMIN_SECRET-guarded)

Body `{ space, owner, repo, installationId, branch? }` → returns the raw
`wfi_` code exactly once. Re-runnable for extra codes. Revocation is a manual
KV delete (pilot scale, same as product-repos). Lives in
`gateway/src/tenancy.ts` beside `/admin/members`.

### `POST /join` (public)

Body `{ invite, author, authorEmail }`:

1. Hash the code, load the invite. Missing, expired, or exhausted → one
   generic `400 "invalid or expired invite"` (no probing oracle).
2. Decrement `usesLeft`, write back.
3. Mint through the same member-creation path as the admin handler — both
   call a shared `mintMember()` extracted from `handleAdminAddMember` (the
   admin handler keeps its request/response shape). Space-repo registration
   happens exactly as today.
4. Return `{ token, member }` once.

Known race: decrement-then-mint over KV can over-admit by ~1 under
concurrent joins. Accepted at pilot scale; mark with a `ponytail:` comment.

### CLI

`wayform init --remote --gateway <url> --invite wfi_…` as an alternative to
`--token`: POST `/join` first (author/email from git config; `--name` /
`--email` override), then proceed through the existing init-remote flow
unchanged — same 0600 secret-file writes, same client configs. One
paste-able line for the acceptance email; the playbook's iMessage warning
applies to it.

### Operator side

`wayform space create` also mints and prints an invite code in its teammate
handoff. Playbook Checklist B step 1 collapses to "dev runs the init line
with the team invite." Because the operator does not witness `/join` mints,
the endpoint logs one structured line per successful join (`space`, `author`,
token **hash** — the revoke handle; never the raw token) so ledger rows can
be appended from Workers logs.

## Testing

- Gateway vitest, beside existing tenancy tests: invite mint; join happy
  path; expired; exhausted; bad code; use-count decrement.
- CLI test: `--invite` exchange against a mocked gateway.
- Cold-onboard rehearsal exercises the real flow end to end.

## Out of scope (deferred)

Leader-generated invites, roles, revocation endpoints, email verification,
web signup, OAuth.
