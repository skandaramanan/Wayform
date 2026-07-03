/**
 * The entry markdown shape: one source of truth for how an entry is serialized
 * to disk (write path) and parsed back (read path). Keeping both here means the
 * two can never drift into incompatible formats — the same reason the projection
 * lives once in context-format.ts.
 */
/**
 * Render an entry to its on-disk markdown: a frontmatter block followed by the
 * trimmed payload. This is the ONLY place the write format is defined.
 */
export function serializeEntry(fm, payload) {
    return (`---\n` +
        `author: ${fm.author}\n` +
        `type: ${fm.type}\n` +
        `timestamp: ${fm.timestamp}\n` +
        `id: ${fm.id}\n` +
        `project: ${fm.project}\n` +
        `---\n\n` +
        `${payload.trim()}\n`);
}
/**
 * Parse an on-disk entry back into a ParsedEntry, or null if it is malformed
 * (no frontmatter, or missing the required author/timestamp). This is the ONLY
 * place the read format is defined.
 */
export function parseEntry(raw, file) {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match)
        return null;
    const front = Object.fromEntries(match[1]
        .split("\n")
        .map((line) => {
        const idx = line.indexOf(":");
        return idx === -1
            ? null
            : [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    })
        .filter((x) => x !== null));
    if (!front.timestamp || !front.author)
        return null;
    return {
        author: front.author,
        type: front.type || "context",
        timestamp: front.timestamp,
        id: front.id || "",
        payload: match[2].trim(),
        file,
    };
}
//# sourceMappingURL=frontmatter.js.map