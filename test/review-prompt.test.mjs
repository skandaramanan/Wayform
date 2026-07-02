import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewInstruction } from "../dist/review-prompt.js";

test("interpolates the project name", () => {
  const out = reviewInstruction("business-one");
  assert.match(out, /business-one/);
});

test("names the write_context tool to call", () => {
  assert.match(reviewInstruction("memorylayer"), /write_context/);
});

test("states the 'because' requirement for a settled decision", () => {
  assert.match(reviewInstruction("memorylayer"), /because/i);
});

test("tells the model to do nothing when nothing qualifies (anti-junk-drawer)", () => {
  const out = reviewInstruction("memorylayer");
  assert.match(out, /nothing/i);
  assert.match(out, /curated|firehose/i);
});

test("instructs deduplication against already-recorded context", () => {
  assert.match(reviewInstruction("memorylayer"), /duplicat|already/i);
});
