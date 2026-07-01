import { test } from "node:test";
import assert from "node:assert/strict";
import { slug, parseEntry } from "../dist/store.js";

test("slug lowercases and collapses non-alphanumeric runs", () => {
  assert.equal(slug("Business One"), "business-one");
  assert.equal(slug("  Trailing --Dashes__ "), "trailing-dashes");
  assert.equal(slug("café déjà"), "caf-d-j");
});

test("slug is a path-traversal guard (CQ3)", () => {
  const s = slug("../../etc/passwd");
  assert.ok(!s.includes("/"), "no slashes survive slug");
  assert.ok(!s.includes(".."), "no parent refs survive slug");
  assert.equal(s, "etc-passwd");
});

test("slug never returns empty", () => {
  assert.equal(slug("!!!"), "unknown");
  assert.equal(slug(""), "unknown");
});

test("parseEntry round-trips a well-formed entry", () => {
  const raw = [
    "---",
    "author: Alice",
    "type: decision",
    "timestamp: 2026-07-01T12:00:00.000Z",
    "id: abc123",
    "project: business-one",
    "---",
    "",
    "Use per-author append files because concurrent writes never conflict.",
    "",
  ].join("\n");
  const e = parseEntry(raw, "context/business-one/alice/x.md");
  assert.equal(e.author, "Alice");
  assert.equal(e.type, "decision");
  assert.equal(e.timestamp, "2026-07-01T12:00:00.000Z");
  assert.equal(e.id, "abc123");
  assert.match(e.payload, /per-author append files/);
});

test("parseEntry returns null when frontmatter is missing", () => {
  assert.equal(parseEntry("just a body, no frontmatter", "x.md"), null);
});

test("parseEntry returns null without required author/timestamp", () => {
  const raw = "---\ntype: decision\n---\n\nbody\n";
  assert.equal(parseEntry(raw, "x.md"), null);
});

test("parseEntry keeps only the first colon per frontmatter line", () => {
  // Known limitation surfaced in review (CQ1): a value containing ': ' still
  // parses because we split on the FIRST colon. Locks current behavior.
  const raw =
    "---\nauthor: Alice\ntimestamp: 2026-07-01T12:00:00.000Z\n---\n\nRatio 3:2 matters\n";
  const e = parseEntry(raw, "x.md");
  assert.equal(e.author, "Alice");
  assert.match(e.payload, /Ratio 3:2/);
});
