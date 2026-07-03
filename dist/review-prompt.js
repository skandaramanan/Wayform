/**
 * Neutral builder for the end-of-turn self-review instruction (write-trigger Path C).
 *
 * This text is vendor-NEUTRAL and lives in exactly one place: only the Stop-hook
 * envelope that carries it is per-vendor (see ./hook-clients.ts). The instruction is
 * the reliable, hook-forced counterpart to the model spontaneously choosing to call
 * write_context (the ~60-85% path that decays over long chats).
 */
export function reviewInstruction(project) {
    return (`MemoryLayer end-of-turn review for project "${project}". ` +
        `Before finishing: did THIS turn settle a deliberate decision, or establish ` +
        `durable context, that is not already recorded in the shared store? A settled ` +
        `decision is "we decided X because Y" — not an open question, an option still ` +
        `under discussion, or an intermediate reasoning step. ` +
        `If yes, call the write_context tool now (project: "${project}", ` +
        `type: "decision" for a settled call or "context" for durable background) with ` +
        `a compact statement that includes the "because". ` +
        `Deduplicate against what is already recorded in this session — do NOT rewrite ` +
        `anything already stored. ` +
        `If nothing qualifies, do nothing and finish normally. ` +
        `Keep the store curated, not a firehose.`);
}
//# sourceMappingURL=review-prompt.js.map