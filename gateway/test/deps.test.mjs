import { test } from "node:test";
import assert from "node:assert/strict";
import { indexDeps } from "../dist/gateway/src/deps.js";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";

test("indexDeps resolves gen from env.AI text-gen; null when no AI", async () => {
  const calls = [];
  const env = {
    indexDb: new MemoryIndexDb(),
    AI: {
      async run(model, input) {
        calls.push({ model, input });
        return input.text ? { data: [[1]] } : { response: "[]" };
      },
    },
  };
  const deps = indexDeps(env);
  assert.ok(deps.gen);
  const out = await deps.gen("hello");
  assert.equal(out, "[]");
  assert.ok(calls.some((c) => c.input.prompt === "hello"));

  const noai = indexDeps({ indexDb: new MemoryIndexDb() });
  assert.equal(noai.gen, null);
});

test("indexDeps prefers the env.genText seam over env.AI", async () => {
  const deps = indexDeps({
    indexDb: new MemoryIndexDb(),
    genText: async () => "seam",
  });
  assert.equal(await deps.gen("x"), "seam");
});

test("indexDeps returns null when no index is configured", () => {
  assert.equal(indexDeps({}), null);
});

test("embed charges its neurons to the daily counter; a single query is free", async () => {
  const kv = new Map();
  const env = {
    indexDb: new MemoryIndexDb(),
    ROUTING: {
      async get(k) {
        return kv.get(k) ?? null;
      },
      async put(k, v) {
        kv.set(k, v);
      },
    },
    AI: {
      async run(_model, input) {
        return { data: input.text.map(() => [1]) };
      },
    },
  };
  const deps = indexDeps(env);
  await deps.embed(["short query"]);
  assert.equal(kv.size, 0, "sub-neuron batch must not touch KV");
  await deps.embed(Array(500).fill("word ".repeat(100)));
  const spent = Number([...kv.values()][0]);
  assert.ok(spent > 0, `reindex-sized batch charged, got ${spent}`);
});
