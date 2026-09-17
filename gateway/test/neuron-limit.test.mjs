import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reserveNeurons,
  remainingNeurons,
  dailyNeuronLimit,
  budgetLimitKey,
  DAILY_NEURON_BUDGET,
  NEURON_BUDGET_HARD_MAX,
} from "../dist/gateway/src/neuron-budget.js";
import { renderSearchResults } from "../dist/gateway/src/retrieval.js";
import { FakeKV } from "./helpers.mjs";

test("a dated limit raises today's budget and nothing else", async () => {
  const env = { ROUTING: new FakeKV() };
  assert.equal(await dailyNeuronLimit(env), DAILY_NEURON_BUDGET);
  await env.ROUTING.put(budgetLimitKey(), "85000");
  assert.equal(await dailyNeuronLimit(env), 85000);
  assert.equal(await reserveNeurons(env, 50000), true);
  assert.equal(await remainingNeurons(env), 35000);

  const other = { ROUTING: new FakeKV() };
  await other.ROUTING.put(budgetLimitKey("2000-01-01"), "85000");
  assert.equal(
    await dailyNeuronLimit(other),
    DAILY_NEURON_BUDGET,
    "a raise for another date never applies today",
  );
});

test("no key can lift the limit past the hard maximum", async () => {
  const env = { ROUTING: new FakeKV() };
  await env.ROUTING.put(budgetLimitKey(), "9000000");
  assert.equal(await dailyNeuronLimit(env), NEURON_BUDGET_HARD_MAX);
  assert.equal(await reserveNeurons(env, NEURON_BUDGET_HARD_MAX + 1), false);
});

test("a truncated search fact shows its id once", () => {
  const body = "long fact ".repeat(80);
  const text = renderSearchResults(
    "p",
    "q",
    [
      {
        doc: {
          id: "e#1",
          space: "s",
          project: "p",
          kind: "decision",
          tier: "normal",
          body,
          sourceFile: "f.md",
          sourceAuthor: "A",
          sourceTs: "2026-09-17T00:00:00Z",
          embedding: [],
          supersededBy: null,
          createdAt: "2026-09-17T00:00:00Z",
          sourceId: "e",
          entities: [],
        },
        score: 1,
      },
    ],
    1,
  );
  assert.equal((text.match(/e#1/g) ?? []).length, 1);
  assert.match(text, /truncated/);
});
