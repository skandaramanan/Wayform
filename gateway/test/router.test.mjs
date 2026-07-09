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

test("OPTIONS preflight on /mcp/<token> returns 204 with CORS headers", async () => {
  const res = await handleRequest(
    new Request("https://gw.test/mcp/mlk_x", {
      method: "OPTIONS",
      headers: {
        origin: "https://chatgpt.com",
        "access-control-request-method": "POST",
      },
    }),
    makeEnv(),
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-methods"), /POST/);
});

test("a normal response still carries CORS headers (browser can read the body)", async () => {
  const res = await handleRequest(
    new Request("https://gw.test/health"),
    makeEnv(),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await res.json(), { ok: true });
});
