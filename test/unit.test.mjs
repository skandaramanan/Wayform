import { test } from "node:test";
import assert from "node:assert/strict";
import { slug } from "../dist/store.js";

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
