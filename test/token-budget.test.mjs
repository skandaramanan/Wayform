import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  DEFAULT_BUDGET_TOKENS,
  ENTRY_OVERHEAD_TOKENS,
} from "../dist/token-budget.js";

test("estimateTokens approximates chars/4, rounded up", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("ab"), 1); // 2/4 -> ceil -> 1
  assert.equal(estimateTokens("abcd"), 1); // 4/4 -> 1
  assert.equal(estimateTokens("abcde"), 2); // 5/4 -> ceil -> 2
  assert.equal(estimateTokens("a".repeat(400)), 100);
});

test("DEFAULT_BUDGET_TOKENS and ENTRY_OVERHEAD_TOKENS are positive constants", () => {
  assert.equal(DEFAULT_BUDGET_TOKENS, 4000);
  assert.equal(ENTRY_OVERHEAD_TOKENS, 12);
});
