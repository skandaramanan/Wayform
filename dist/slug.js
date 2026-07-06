/**
 * Collapse arbitrary text to a filesystem-safe slug. Also the path-traversal
 * guard: stripping every non-alphanumeric run means "../../etc" -> "etc", so a
 * hostile project/author name can never escape the context/ directory.
 *
 * Lives in its own dependency-free module so the hosted gateway (Web APIs
 * only, no node:*) shares the exact same guard as the local store.
 */
export function slug(s) {
    return (s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "unknown");
}
/** ISO timestamp -> filename-safe form (colons/dots to dashes). */
export function fsSafeTimestamp(iso) {
    return iso.replace(/[:.]/g, "-");
}
//# sourceMappingURL=slug.js.map