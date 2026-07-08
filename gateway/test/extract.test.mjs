import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractFacts,
  buildExtractionPrompt,
} from "../dist/gateway/src/extract.js";
import { fakeGenText } from "./helpers.mjs";

const entry = (payload, type = "decision") => ({
  author: "Skanda",
  type,
  timestamp: "2026-07-04T00:00:00Z",
  id: "abc123",
  payload,
  file: "context/memorylayer/skanda/f.md",
});

test("buildExtractionPrompt includes the entry body and the fidelity instruction", () => {
  const p = buildExtractionPrompt(
    entry("Cursor MCP config is project-scoped."),
  );
  assert.match(p, /Cursor MCP config is project-scoped\./);
  assert.match(p, /do not infer|only what the (entry|source) states/i);
});

test("extractFacts parses a valid JSON array into normalized facts", async () => {
  const gen = fakeGenText({
    "Cursor MCP": JSON.stringify([
      {
        kind: "constraint",
        tier: "canon",
        body: "Cursor MCP config is project-scoped, not global.",
        entities: ["Cursor", "MCP Config"],
      },
      {
        kind: "context",
        tier: "normal",
        body: "Verified on 2026-07-04.",
        entities: [],
      },
    ]),
  });
  const facts = await extractFacts(
    gen,
    entry("Cursor MCP config is project-scoped."),
  );
  assert.equal(facts.length, 2);
  assert.equal(facts[0].tier, "canon");
  assert.deepEqual(facts[0].entities, ["cursor", "mcp-config"]); // slugged + deduped
});

test("extractFacts tolerates code-fenced JSON", async () => {
  const gen = fakeGenText({
    marker:
      '```json\n[{"kind":"decision","tier":"normal","body":"We picked D1.","entities":[]}]\n```',
  });
  const facts = await extractFacts(gen, entry("marker: chose D1"));
  assert.equal(facts.length, 1);
  assert.equal(facts[0].body, "We picked D1.");
});

test("extractFacts recovers JSON wrapped in prose (8B models ignore 'JSON only')", async () => {
  const gen = async () =>
    'Sure! Here are the atomic facts:\n[{"kind":"decision","tier":"normal","body":"We picked D1.","entities":["d1"]}]\nHope that helps!';
  const facts = await extractFacts(gen, entry("chose D1"));
  assert.equal(facts.length, 1);
  assert.equal(facts[0].body, "We picked D1.");
  assert.deepEqual(facts[0].entities, ["d1"]);
});

test("extractFacts recovers a valid array followed by trailing chatter (the llama-3.3-70b failure)", async () => {
  const gen = async () =>
    '[{"kind":"decision","tier":"normal","body":"We chose D1.","entities":["d1"]}]\n\nLet me know if you need more facts!';
  const facts = await extractFacts(gen, entry("chose D1"));
  assert.equal(facts.length, 1);
  assert.equal(facts[0].body, "We chose D1.");
});

test("extractJsonArray is not fooled by brackets inside string values", async () => {
  const gen = async () =>
    'Sure:\n[{"kind":"context","tier":"normal","body":"array syntax is [x, y]","entities":[]}] done';
  const facts = await extractFacts(gen, entry("note about arrays"));
  assert.equal(facts.length, 1);
  assert.equal(facts[0].body, "array syntax is [x, y]");
});

test("fail-open floor: null gen → one normal fact = whole entry body", async () => {
  const facts = await extractFacts(null, entry("some prose", "context"));
  assert.deepEqual(facts, [
    { kind: "context", tier: "normal", body: "some prose", entities: [] },
  ]);
});

test("fail-open floor: malformed / non-JSON / throwing gen → one normal fact", async () => {
  const bad = await extractFacts(
    async () => "not json at all",
    entry("prose body"),
  );
  assert.deepEqual(bad, [
    { kind: "decision", tier: "normal", body: "prose body", entities: [] },
  ]);
  const boom = await extractFacts(async () => {
    throw new Error("model down");
  }, entry("prose body"));
  assert.equal(boom.length, 1);
  assert.equal(boom[0].body, "prose body");
});

test("fail-open floor: valid JSON but empty array → one normal fact (never index nothing)", async () => {
  const facts = await extractFacts(async () => "[]", entry("prose body"));
  assert.equal(facts.length, 1);
  assert.equal(facts[0].body, "prose body");
});

test("extractFacts drops facts with an empty body but keeps the rest", async () => {
  const gen = async () =>
    JSON.stringify([
      { kind: "decision", tier: "normal", body: "", entities: [] },
      { kind: "decision", tier: "normal", body: "kept", entities: [] },
    ]);
  const facts = await extractFacts(gen, entry("x"));
  assert.deepEqual(
    facts.map((f) => f.body),
    ["kept"],
  );
});
