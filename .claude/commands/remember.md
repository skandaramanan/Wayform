---
description: Record a settled decision to the shared MemoryLayer store
---

Record a decision to the shared MemoryLayer planning store for this project.

If text was provided after the command, use it as the decision. Otherwise, use the
most recently settled decision from our conversation.

Call the `write_context` tool now with:
- project: "memorylayer"
- type: "decision" (or "context" for durable background)
- payload: a compact statement of the decision that includes the "because" — the
  reasoning that settles it.

Record only settled decisions — never open questions or options still under discussion.
Keep it compact; the store is curated, not a firehose.

$ARGUMENTS
