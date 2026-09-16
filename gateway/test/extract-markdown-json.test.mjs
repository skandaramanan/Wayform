import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFactsDetailed } from "../dist/gateway/src/extract.js";

const entry = {
  author: "GitHub",
  type: "context",
  timestamp: "2026-09-12T22:33:15Z",
  id: "6642b218",
  payload:
    "PR merged: Add `wayform token`, and stop doctor blaming the network",
  file: "context/memorylayer/github/6642b218.md",
};

test("finds the fact array after markdown, link brackets and a non-JSON code fence", async () => {
  // Shape of the real completion that floored every day (2026-09-17 replay).
  const completion = [
    "` in the `wayform` CLI, see [the docs](https://example.com).",
    "",
    "## 2. Doctor probe",
    "",
    "```bash",
    "# doctor --help",
    "wayform doctor",
    "```",
    "",
    "[",
    '  {"kind": "context", "tier": "normal", "body": "PR merged: Add `wayform token`", "entities": ["wayform-token"]},',
    '  {"kind": "decision", "tier": "normal", "body": "doctor no longer blames the network for a slow read", "entities": ["doctor"]}',
    "]",
  ].join("\n");
  const { facts, floored } = await extractFactsDetailed(
    async () => completion,
    entry,
  );
  assert.equal(floored, false);
  assert.equal(facts.length, 2);
  assert.equal(facts[1].entities[0], "doctor");
});

test("an array of strings in prose is not mistaken for the facts", async () => {
  const completion =
    'Tags: ["a", "b"]\n[{"kind":"decision","tier":"normal","body":"real fact","entities":[]}]';
  const { facts, floored } = await extractFactsDetailed(
    async () => completion,
    entry,
  );
  assert.equal(floored, false);
  assert.equal(facts[0].body, "real fact");
});
