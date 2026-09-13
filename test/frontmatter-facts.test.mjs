import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeEntry, parseEntry } from "../dist/frontmatter.js";

const fm = {
  author: "Ada",
  type: "decision",
  timestamp: "2026-09-13T00:00:00.000Z",
  id: "abc",
  project: "memorylayer",
};

test("writer-split facts round-trip through the frontmatter", () => {
  const facts = [
    { kind: "decision", body: "Reindex never wipes: a wipe re-extracts all." },
    {
      kind: "constraint",
      tier: "canon",
      body: "Line\nbreaks: stay escaped",
      entities: ["x"],
    },
  ];
  const raw = serializeEntry({ ...fm, facts }, "prose record");
  const parsed = parseEntry(raw, "f.md");
  assert.deepEqual(parsed.facts, facts);
  assert.equal(
    parsed.payload,
    "prose record",
    "facts never leak into the payload",
  );
});

test("an entry without facts serializes exactly as before", () => {
  const raw = serializeEntry(fm, "body");
  assert.doesNotMatch(raw, /facts:/);
  assert.equal("facts" in parseEntry(raw, "f.md"), false);
});

test("malformed facts are dropped, never fatal", () => {
  const raw = serializeEntry(fm, "body").replace(
    "project: memorylayer\n",
    'project: memorylayer\nfacts: [{"kind":"decision"}, not json\n',
  );
  const parsed = parseEntry(raw, "f.md");
  assert.ok(parsed, "the entry still parses");
  assert.equal(parsed.facts, undefined);
});
