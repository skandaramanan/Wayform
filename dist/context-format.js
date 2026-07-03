/**
 * Render a project's entries into the markdown block that read_context returns
 * and the session-start hook injects. Shared so the MCP tool and the hook can
 * never drift into two different projections of the same store.
 */
export function projectContext(project, entries, total) {
    if (total === 0) {
        return `# Shared context: ${project}\n\n(No entries yet. Use write_context to record the first decision.)`;
    }
    const header = total > entries.length
        ? `# Shared context: ${project}\n\n_Showing the ${entries.length} most recent of ${total} entries._`
        : `# Shared context: ${project}`;
    const body = entries
        .map((e) => `## ${e.type} — ${e.author} — ${e.timestamp}\n\n${e.payload}`)
        .join("\n\n---\n\n");
    return `${header}\n\n${body}`;
}
//# sourceMappingURL=context-format.js.map