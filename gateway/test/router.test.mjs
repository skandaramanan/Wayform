import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
import { makeEnv } from "./helpers.mjs";

test("GET /health returns ok json", async () => {
  const res = await handleRequest(
    new Request("https://gw.test/health"),
    makeEnv(),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("unknown path returns 404", async () => {
  const res = await handleRequest(
    new Request("https://gw.test/nope"),
    makeEnv(),
  );
  assert.equal(res.status, 404);
});
