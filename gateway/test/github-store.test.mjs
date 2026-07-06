import { test } from "node:test";
import assert from "node:assert/strict";
import {
  writeEntry,
  readEntries,
  MAX_ENTRY_FETCH,
} from "../dist/gateway/src/github-store.js";
import { parseEntry } from "../dist/src/frontmatter.js";
import { makeEnv, ghFetch } from "./helpers.mjs";

const MEMBER = {
  space: "team-a",
  installationId: 777,
  owner: "acme",
  repo: "team-a-memory",
  branch: "main",
  author: "Ada",
  authorEmail: "ada@acme.io",
};

const TOKEN_ROUTE = [
  "/app/installations/777/access_tokens",
  () => Response.json({ token: "ghs_x" }, { status: 201 }),
];

function entryMd(ts, author, payload) {
  return `---\nauthor: ${author}\ntype: context\ntimestamp: ${ts}\nid: abcd1234\nproject: roadmap\n---\n\n${payload}\n`;
}

test("writeEntry PUTs a byte-compatible entry to the member repo", async () => {
  const calls = [];
  const fetchImpl = ghFetch(calls, [
    TOKEN_ROUTE,
    ["/contents/", (url, init) => Response.json({ ok: true }, { status: 201 })],
  ]);
  const out = await writeEntry(
    makeEnv(fetchImpl),
    MEMBER,
    "Road Map!",
    {
      type: "decision",
      payload: "We decided X because Y.\nSecond line.",
    },
    fetchImpl,
  );

  const put = calls.find((c) => c.init.method === "PUT");
  assert.match(
    put.url,
    /^https:\/\/api\.github\.com\/repos\/acme\/team-a-memory\/contents\/context\/road-map\/ada\//,
  );
  const body = JSON.parse(put.init.body);
  assert.equal(body.branch, "main");
  assert.equal(
    body.message.startsWith("decision(road-map): We decided X because Y."),
    true,
  );
  assert.deepEqual(body.author, { name: "Ada", email: "ada@acme.io" });

  // THE interop guarantee: content round-trips through the local parser
  const content = Buffer.from(body.content, "base64").toString("utf8");
  const parsed = parseEntry(content, out.file);
  assert.equal(parsed.author, "Ada");
  assert.equal(parsed.type, "decision");
  assert.equal(parsed.payload, "We decided X because Y.\nSecond line.");
  assert.equal(parsed.timestamp, out.timestamp);
});

test("readEntries: tree + raw fetch, sorted by timestamp, budget-packed, total preserved", async () => {
  const tree = {
    tree: [
      {
        path: "context/roadmap/ada/2026-07-01T10-00-00-000Z-aaaaaaaa.md",
        type: "blob",
      },
      {
        path: "context/roadmap/bo/2026-07-02T10-00-00-000Z-bbbbbbbb.md",
        type: "blob",
      },
      {
        path: "context/other-project/ada/2026-07-03T10-00-00-000Z-cccccccc.md",
        type: "blob",
      },
      { path: "context/roadmap/ada/not-markdown.txt", type: "blob" },
    ],
  };
  const fetchImpl = ghFetch(
    [],
    [
      TOKEN_ROUTE,
      ["/git/trees/main?recursive=1", () => Response.json(tree)],
      [
        "2026-07-01T10-00-00-000Z-aaaaaaaa.md",
        () => new Response(entryMd("2026-07-01T10:00:00.000Z", "Ada", "first")),
      ],
      [
        "2026-07-02T10-00-00-000Z-bbbbbbbb.md",
        () => new Response(entryMd("2026-07-02T10:00:00.000Z", "Bo", "second")),
      ],
    ],
  );
  const { entries, total } = await readEntries(
    makeEnv(fetchImpl),
    MEMBER,
    "roadmap",
    undefined,
    fetchImpl,
  );
  assert.equal(total, 2); // other-project and .txt excluded
  assert.deepEqual(
    entries.map((e) => e.payload),
    ["first", "second"],
  );
});

test("readEntries caps blob fetches at MAX_ENTRY_FETCH newest files, total stays full", async () => {
  const files = [];
  const blobRoutes = [];
  for (let i = 0; i < 60; i++) {
    const day = String(i + 1).padStart(2, "0");
    const p = `context/roadmap/ada/2026-06-${day}T00-00-00-000Z-${String(i).padStart(8, "0")}.md`;
    files.push({ path: p, type: "blob" });
    blobRoutes.push([
      p,
      () =>
        new Response(entryMd(`2026-06-${day}T00:00:00.000Z`, "Ada", `e${i}`)),
    ]);
  }
  const calls = [];
  const fetchImpl = ghFetch(calls, [
    TOKEN_ROUTE,
    ["/git/trees/", () => Response.json({ tree: files })],
    ...blobRoutes,
  ]);
  const { entries, total } = await readEntries(
    makeEnv(fetchImpl),
    MEMBER,
    "roadmap",
    0,
    fetchImpl,
  );
  assert.equal(total, 60);
  assert.equal(entries.length, MAX_ENTRY_FETCH); // newest 40 fetched (budget 0 = unlimited packing)
  assert.equal(entries[entries.length - 1].payload, "e59");
  const blobCalls = calls.filter((c) => c.url.includes(".md"));
  assert.equal(blobCalls.length, MAX_ENTRY_FETCH);
});

test("readEntries returns empty on 404/409 tree (empty repo or missing branch)", async () => {
  const fetchImpl = ghFetch(
    [],
    [TOKEN_ROUTE, ["/git/trees/", () => new Response("", { status: 409 })]],
  );
  assert.deepEqual(
    await readEntries(
      makeEnv(fetchImpl),
      MEMBER,
      "roadmap",
      undefined,
      fetchImpl,
    ),
    { entries: [], total: 0 },
  );
});
