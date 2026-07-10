import { test } from "node:test";
import assert from "node:assert/strict";
import { recallAtK } from "../dist/gateway/src/eval-golden.js";

test("recallAtK averages per-case recall and lists misses", () => {
  const cases = [
    { query: "a", expectedIds: ["x1"] },
    { query: "b", expectedIds: ["y1", "y2"] },
  ];
  const retrievedByCase = [
    ["x1", "z9"], // case a: found x1
    ["y1", "z8"], // case b: found y1, missed y2
  ];
  const { recall, perCase } = recallAtK(cases, retrievedByCase, 10);
  assert.equal(perCase[0].recall, 1);
  assert.equal(perCase[1].recall, 0.5);
  assert.equal(recall, 0.75);
  assert.deepEqual(perCase[1].missing, ["y2"]);
});

test("recallAtK honours the k cutoff", () => {
  const cases = [{ query: "a", expectedIds: ["x1"] }];
  const { recall } = recallAtK(cases, [["z1", "z2", "x1"]], 2); // x1 is rank 3
  assert.equal(recall, 0);
});
