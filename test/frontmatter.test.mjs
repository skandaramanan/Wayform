import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeEntry, parseEntry } from "../dist/frontmatter.js";

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

test("serializeEntry -> parseEntry round-trips (the drift guard)", () => {
  const fm = {
    author: "Bob",
    type: "context",
    timestamp: "2026-07-02T09:30:00.000Z",
    id: "deadbeef",
    project: "business-one",
  };
  const payload = "Multi-line body.\n\nSecond paragraph with a --- separator.";
  const raw = serializeEntry(fm, payload);
  const parsed = parseEntry(raw, "context/business-one/bob/y.md");

  assert.equal(parsed.author, fm.author);
  assert.equal(parsed.type, fm.type);
  assert.equal(parsed.timestamp, fm.timestamp);
  assert.equal(parsed.id, fm.id);
  // The trimmed payload survives verbatim, including an inner '---'.
  assert.equal(parsed.payload, payload.trim());
});

test("serializeEntry trims surrounding whitespace in the payload", () => {
  const fm = {
    author: "Alice",
    type: "decision",
    timestamp: "2026-07-02T10:00:00.000Z",
    id: "cafef00d",
    project: "proj",
  };
  const raw = serializeEntry(fm, "   padded body   \n\n");
  const parsed = parseEntry(raw, "z.md");
  assert.equal(parsed.payload, "padded body");
});
