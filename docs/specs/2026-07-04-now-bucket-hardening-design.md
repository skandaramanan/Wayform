---
status: SHIPPED
---
# Now-Bucket Hardening Design

## Problem

The local, git-backed core is good enough to prove the MemoryLayer loop, but the
pilot needs better trust properties before asking collaborators to rely on it:

- A pre-existing git repo at the clone path with no `origin` can crash MCP startup.
- Cross-clone push races only retry once.
- A crash between writing an entry file and committing it leaves an untracked orphan.
- Read order depends on each writer's wall clock.
- Runtime hooks fail open by design, but there is no diagnostic command for silent
  failures.
- CI only checks Ubuntu and skips typecheck/format checks.

## Decisions

### Git origin reconciliation

`GitRepo.ensure()` treats the configured `repoUrl` as the source of truth. If `origin`
exists, it is reset to that URL. If it does not exist, `origin` is added. This preserves
clone isolation without crashing on a manually-created `.git`.

### Bounded push retry

`GitRepo.push()` attempts a push up to three times. Between attempts it rebase-pulls
and waits with a small exponential backoff. After the final failure, it keeps the
existing user-facing contract: the entry is recorded locally and will retry on the next
read/write.

### Orphan recovery

`ContextStore` reconciles untracked `context/**/*.md` files before reads and writes.
Valid serialized entries are committed under their recorded author. Malformed files are
left untouched, because silently committing unknown content would be worse than leaving
it visible for manual repair.

### Clock-skew-resistant ordering

Reads sort entries by the git commit date of the commit that introduced each file,
falling back to frontmatter timestamps for uncommitted/local entries. This keeps the
projection tied to integration order rather than laptop wall-clock order.

### Doctor command

`memorylayer doctor` is read-only and never clones or repairs. It checks env-file
presence, config loading, clone origin, remote reachability, unpushed commits, and the
resolved default project. It redacts URL credentials before printing.

### CI

CI runs on Ubuntu and macOS across Node 18/20/22, and gates lint, typecheck,
format-check, and tests.
