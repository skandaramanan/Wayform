import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reserveNeurons,
  DAILY_NEURON_BUDGET,
} from "../dist/gateway/src/neuron-budget.js";

function kvEnv() {
  const store = new Map();
  return {
    ROUTING: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => void store.set(k, v),
      delete: async (k) => void store.delete(k),
    },
  };
}

test("reserves until the daily neuron budget is spent, then refuses", async () => {
  const env = kvEnv();
  const cost = Math.floor(DAILY_NEURON_BUDGET / 2);
  assert.equal(await reserveNeurons(env, cost), true);
  assert.equal(await reserveNeurons(env, cost), true);
  assert.equal(await reserveNeurons(env, cost), false);
});

test("neuron budget fails open when KV reads throw", async () => {
  const env = {
    ROUTING: {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {},
      delete: async () => {},
    },
  };
  assert.equal(await reserveNeurons(env, DAILY_NEURON_BUDGET * 10), true);
});
