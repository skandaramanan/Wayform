import { test } from "node:test";
import assert from "node:assert/strict";
import {
  writeEntry,
  readEntries,
  readEntriesCached,
  recencyCacheKey,
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

test("writeEntry retries the PUT on transient GitHub 5xx and succeeds", async () => {
  let puts = 0;
  const fetchImpl = ghFetch(
    [],
    [
      TOKEN_ROUTE,
      [
        "/contents/",
        () =>
          ++puts < 3
            ? Response.json(
                { message: "No server is currently available" },
                { status: 503 },
              )
            : Response.json({ ok: true }, { status: 201 }),
      ],
    ],
  );
  const out = await writeEntry(
    makeEnv(fetchImpl),
    MEMBER,
    "roadmap",
    { type: "decision", payload: "survives a GitHub blip" },
    fetchImpl,
    [0, 0],
  );
  assert.equal(puts, 3);
  assert.equal(out.payload, "survives a GitHub blip");
});

test("writeEntry gives up after retries on a persistent 5xx, and never retries 4xx", async () => {
  let puts5xx = 0;
  const always503 = ghFetch(
    [],
    [
      TOKEN_ROUTE,
      [
        "/contents/",
        () => (puts5xx++, Response.json({ message: "down" }, { status: 503 })),
      ],
    ],
  );
  await assert.rejects(
    () =>
      writeEntry(
        makeEnv(always503),
        MEMBER,
        "roadmap",
        { type: "decision", payload: "p" },
        always503,
        [0, 0],
      ),
    /write failed: 503/,
  );
  assert.equal(puts5xx, 3); // 1 attempt + 2 retries

  let puts4xx = 0;
  const always422 = ghFetch(
    [],
    [
      TOKEN_ROUTE,
      [
        "/contents/",
        () => (puts4xx++, Response.json({ message: "422" }, { status: 422 })),
      ],
    ],
  );
  await assert.rejects(
    () =>
      writeEntry(
        makeEnv(always422),
        MEMBER,
        "roadmap",
        { type: "decision", payload: "p" },
        always422,
        [0, 0],
      ),
    /write failed: 422/,
  );
  assert.equal(puts4xx, 1); // deterministic failure — no retry
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

test("readEntries fetches blobs in PARALLEL (a later blob starts before an earlier one resolves)", async () => {
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
    ],
  };
  // Blob A only resolves once blob B's fetch has STARTED. A sequential loop
  // never starts B while awaiting A → deadlock → the race below fails loudly.
  let releaseA;
  const bStarted = new Promise((resolve) => (releaseA = resolve));
  const fetchImpl = ghFetch(
    [],
    [
      TOKEN_ROUTE,
      ["/git/trees/main?recursive=1", () => Response.json(tree)],
      [
        "aaaaaaaa.md",
        async () => {
          await bStarted;
          return new Response(
            entryMd("2026-07-01T10:00:00.000Z", "Ada", "first"),
          );
        },
      ],
      [
        "bbbbbbbb.md",
        () => {
          releaseA();
          return new Response(
            entryMd("2026-07-02T10:00:00.000Z", "Bo", "second"),
          );
        },
      ],
    ],
  );
  const timeout = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("blob fetches ran sequentially, not in parallel")),
      2000,
    ),
  );
  const { entries, total } = await Promise.race([
    readEntries(makeEnv(fetchImpl), MEMBER, "roadmap", undefined, fetchImpl),
    timeout,
  ]);
  assert.equal(total, 2);
  // Order is still oldest→newest regardless of resolution order.
  assert.deepEqual(
    entries.map((e) => e.payload),
    ["first", "second"],
  );
});

test("readEntriesCached serves repeat reads from KV with ZERO GitHub calls, budget applied per call", async () => {
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
    ],
  };
  const calls = [];
  const fetchImpl = ghFetch(calls, [
    TOKEN_ROUTE,
    ["/git/trees/main?recursive=1", () => Response.json(tree)],
    [
      "aaaaaaaa.md",
      () =>
        new Response(
          entryMd("2026-07-01T10:00:00.000Z", "Ada", "x".repeat(4000)),
        ),
    ],
    [
      "bbbbbbbb.md",
      () =>
        new Response(
          entryMd("2026-07-02T10:00:00.000Z", "Bo", "y".repeat(4000)),
        ),
    ],
  ]);
  const env = makeEnv(fetchImpl);
  const first = await readEntriesCached(env, MEMBER, "roadmap", 0, fetchImpl);
  assert.equal(first.total, 2);
  assert.equal(first.entries.length, 2);
  const callsAfterFirst = calls.length;
  assert.notEqual(
    await env.ROUTING.get(recencyCacheKey("team-a", "roadmap")),
    null,
  );

  // Repeat read: KV hit, no new GitHub traffic, same result.
  const second = await readEntriesCached(env, MEMBER, "roadmap", 0, fetchImpl);
  assert.equal(calls.length, callsAfterFirst);
  assert.deepEqual(second, first);

  // The cache stores UN-packed entries: a tighter budget on a hit packs down.
  const tight = await readEntriesCached(
    env,
    MEMBER,
    "roadmap",
    1000,
    fetchImpl,
  );
  assert.equal(calls.length, callsAfterFirst);
  assert.equal(tight.total, 2);
  assert.equal(tight.entries.length, 1);
  assert.equal(tight.entries[0].author, "Bo"); // newest survives packing
});

test("readEntriesCached falls through to GitHub when KV is unavailable", async () => {
  const tree = {
    tree: [
      {
        path: "context/roadmap/ada/2026-07-01T10-00-00-000Z-aaaaaaaa.md",
        type: "blob",
      },
    ],
  };
  const fetchImpl = ghFetch(
    [],
    [
      TOKEN_ROUTE,
      ["/git/trees/main?recursive=1", () => Response.json(tree)],
      [
        "aaaaaaaa.md",
        () => new Response(entryMd("2026-07-01T10:00:00.000Z", "Ada", "first")),
      ],
    ],
  );
  const env = makeEnv(fetchImpl);
  const broken = {
    get: async (key) =>
      key.startsWith("recency:") ? Promise.reject(new Error("KV down")) : null,
    put: async (key) => {
      if (key.startsWith("recency:")) throw new Error("KV down");
    },
    delete: async () => {},
  };
  // installationToken caches in ROUTING too — keep that path working.
  const real = env.ROUTING;
  env.ROUTING = {
    get: (k) => (k.startsWith("recency:") ? broken.get(k) : real.get(k)),
    put: (k, v, o) =>
      k.startsWith("recency:") ? broken.put(k) : real.put(k, v, o),
    delete: (k) => real.delete(k),
  };
  const { entries, total } = await readEntriesCached(
    env,
    MEMBER,
    "roadmap",
    undefined,
    fetchImpl,
  );
  assert.equal(total, 1);
  assert.equal(entries[0].payload, "first");
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
