---
status: SHIPPED
---
# Now-Bucket Hardening Implementation Plan

## Tasks

1. Add `GitRepo.ensure()` coverage for an existing `.git` with no `origin`, then add
   the remote-add fallback.
2. Add bounded retry behavior to `GitRepo.push()` while preserving the existing
   "recorded locally, not shared yet" error contract.
3. Add an integration test for untracked entry-file recovery, then reconcile valid
   untracked `context/**/*.md` files before reads and writes.
4. Add a skewed-clock integration test, then sort reads by first-commit date with a
   frontmatter-timestamp fallback.
5. Add the cross-clone concurrent-push integration test to exercise the real rebase
   retry path.
6. Add `src/doctor.ts`, route `memorylayer doctor` through `src/cli.ts`, document it
   in `README.md`, and test env validation, redaction, healthy output, and failing
   origin mismatch.
7. Expand CI to Ubuntu/macOS across Node 18/20/22 with lint, typecheck, format-check,
   and tests.
8. Rebuild `dist/`, run the full verification suite, and commit source, tests, docs,
   and generated dist together.

## Validation

- `npm run lint`
- `npm run typecheck`
- `npm run format:check`
- `npm test`
