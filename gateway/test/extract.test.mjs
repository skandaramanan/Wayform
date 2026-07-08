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
