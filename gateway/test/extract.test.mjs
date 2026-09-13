import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractFacts,
  buildExtractionPrompt,
  floorEntities,
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

test("floorEntities pulls identifier-shaped tags so an untagged fact is impossible", () => {
  // Why this exists: the LLM extractor returns entities:[] when it fails, and
  // an untagged fact is invisible to entityRank — one of three generators.
  // RRF scores by how many lists a doc appears in, so on 2026-09-13 the only
  // doc of 425 containing "Mosaic" ranked 16th for a query of its own rarest
  // terms, because it reached BM25 alone.
  const tags = floorEntities(
    "Set ADMIN_GITHUB_IDS in `wrangler.toml` so requireOperator resolves. " +
      "See gateway/src/rank.ts and the product-repos:registry blob.",
  );
  assert.ok(tags.includes("admin_github_ids"), "ALLCAPS constants");
  assert.ok(tags.includes("wrangler.toml"), "backticked spans");
  // Paths and namespaces split on / and : — deliberate. entityRank tokenizes
  // tags before matching, so "rank.ts" still overlaps a query about
  // gateway/src/rank.ts, and the shorter tag matches more phrasings.
  assert.ok(
    tags.includes("rank.ts"),
    "dotted filenames survive path splitting",
  );
  assert.ok(tags.includes("product-repos"), "kebab identifiers");
});

test("floorEntities is deduped, lowercased, bounded, and never empty-ish junk", () => {
  const tags = floorEntities(
    "`a` `ab` " + "WEBHOOK_SECRET ".repeat(30) + "x_y ".repeat(30),
  );
  assert.ok(tags.length <= 12, "capped so tags stay few and stable");
  assert.equal(new Set(tags).size, tags.length, "deduped");
  assert.ok(
    tags.every((t) => t === t.toLowerCase()),
    "normalized",
  );
  assert.ok(
    tags.every((t) => t.length >= 3),
    "1-2 char noise dropped",
  );
});

test("the extraction floor tags the fact it falls back to", async () => {
  // extractFacts(null, …) takes the floor path directly.
  const [fact] = await extractFacts(null, {
    file: "x.md",
    type: "decision",
    payload: "Pinned gitleaks in `ci.yml` because GITHUB_API rate-limited.",
  });
  assert.equal(fact.body.startsWith("Pinned gitleaks"), true);
  assert.ok(
    fact.entities.length > 0,
    "the floor must never emit an untagged fact",
  );
});
