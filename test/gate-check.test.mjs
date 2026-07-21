import { test } from "node:test";
import assert from "node:assert/strict";
test("deliberate failure to verify branch protection blocks merges", () => {
  assert.equal(1, 2);
});
