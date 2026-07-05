import { test } from "node:test";
import assert from "node:assert/strict";
import { slug, fsSafeTimestamp } from "../dist/slug.js";
import { packToBudget } from "../dist/token-budget.js";
import { slug as storeSlug } from "../dist/store.js";

test("slug module: traversal guard and store re-export stay identical", () => {
  assert.equal(slug("../../etc"), "etc");
  assert.equal(slug("My Project!"), "my-project");
  assert.equal(slug(""), "unknown");
  assert.equal(storeSlug, slug); // same function object, one source of truth
});

test("fsSafeTimestamp strips colons and dots", () => {
  assert.equal(
    fsSafeTimestamp("2026-07-05T06:11:22.854Z"),
    "2026-07-05T06-11-22-854Z",
  );
});

function entry(payload, file) {
  return {
    author: "a",
    type: "context",
    timestamp: "t",
    id: "i",
    payload,
    file,
  };
}

test("packToBudget keeps newest entries within budget, oldest dropped first", () => {
  const entries = [
    entry("x".repeat(400), "1"),
    entry("y".repeat(400), "2"),
    entry("z".repeat(400), "3"),
  ];
  // each entry ~100 tokens + 12 overhead; budget 240 fits two
  const out = packToBudget(entries, 240);
  assert.deepEqual(
    out.map((e) => e.file),
    ["2", "3"],
  );
});

test("packToBudget always keeps at least the most recent entry", () => {
  const out = packToBudget([entry("x".repeat(4000), "big")], 10);
  assert.equal(out.length, 1);
});

test("packToBudget budget <= 0 means unlimited", () => {
  const entries = [entry("a", "1"), entry("b", "2")];
  assert.equal(packToBudget(entries, 0).length, 2);
});
