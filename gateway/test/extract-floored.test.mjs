import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFactsDetailed } from "../dist/gateway/src/extract.js";

const good = JSON.stringify([
  { kind: "decision", tier: "normal", body: "chunk fact", entities: ["x"] },
]);
const entry = (payload) => ({
  author: "A",
  type: "decision",
  timestamp: "2026-09-14T00:00:00Z",
  id: "e",
  payload,
  file: "context/p/a/e.md",
});
const long = ["P".repeat(900), "Q".repeat(900), "R".repeat(900)].join("\n\n");

test("a long entry where only some chunks failed is not queued for a full retry", async () => {
  let call = 0;
  const gen = async () => (++call === 2 ? "not json" : good);
  const { facts, floored } = await extractFactsDetailed(gen, entry(long));
  assert.equal(floored, false, "partial success must not re-buy every chunk");
  assert.ok(facts.some((f) => f.body === "chunk fact"));
});

test("a long entry where every chunk failed is floored", async () => {
  const { floored } = await extractFactsDetailed(
    async () => "not json",
    entry(long),
  );
  assert.equal(floored, true);
});
