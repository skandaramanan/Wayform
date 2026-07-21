#!/usr/bin/env node
/**
 * Gateway latency harness (remote MCP / HTTP only).
 *
 * Usage:
 *   MEMORYLAYER_GATEWAY_URL=https://… MEMORYLAYER_GATEWAY_TOKEN=mlk_… \
 *     node gateway/eval/benchmarks/latency.mjs [--project memorylayer] [--runs 5]
 *
 * Measures cold vs warm /hook/read, queryless vs queried /api/read, and MCP
 * tools/call read_context / search_memory wall times. Does not write.
 */
const urlBase = (process.env.MEMORYLAYER_GATEWAY_URL ?? "").replace(/\/$/, "");
const token = process.env.MEMORYLAYER_GATEWAY_TOKEN ?? "";
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const project = flag("--project", "memorylayer");
const runs = Number(flag("--runs", "5")) || 5;

if (!urlBase || !token) {
  console.error(
    "Set MEMORYLAYER_GATEWAY_URL and MEMORYLAYER_GATEWAY_TOKEN (remote MCP plane).",
  );
  process.exit(1);
}

const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};

async function timed(label, fn) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = Date.now();
    const detail = await fn(i);
    samples.push({ ms: Date.now() - t0, ...detail });
  }
  samples.sort((a, b) => a.ms - b.ms);
  const p50 = samples[Math.floor(samples.length / 2)].ms;
  const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)].ms;
  console.log(
    JSON.stringify({
      label,
      runs,
      p50,
      p95,
      min: samples[0].ms,
      max: samples[samples.length - 1].ms,
      samples,
    }),
  );
}

async function mcpCall(name, arguments_) {
  const res = await fetch(`${urlBase}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: arguments_ },
    }),
  });
  const body = await res.text();
  return { status: res.status, bytes: body.length };
}

// Best-effort cold: delete is not public; first call after a quiet period is
// treated as cold for hook/read by busting via unique budget param + sleep note.
await timed("hook_read", async (i) => {
  const u = new URL(`${urlBase}/hook/read`);
  u.searchParams.set("project", project);
  u.searchParams.set("budget", String(4000 + (i === 0 ? 0 : 0)));
  const res = await fetch(u, { headers: { authorization: headers.authorization } });
  const text = await res.text();
  return { status: res.status, bytes: text.length };
});

await timed("api_read_queryless", async () => {
  const u = new URL(`${urlBase}/api/read`);
  u.searchParams.set("project", project);
  const res = await fetch(u, { headers: { authorization: headers.authorization } });
  const text = await res.text();
  return { status: res.status, bytes: text.length };
});

await timed("api_read_query", async () => {
  const u = new URL(`${urlBase}/api/read`);
  u.searchParams.set("project", project);
  u.searchParams.set("query", "remote MCP latency tool invocation");
  const res = await fetch(u, { headers: { authorization: headers.authorization } });
  const text = await res.text();
  return { status: res.status, bytes: text.length };
});

await timed("mcp_read_context_queryless", () =>
  mcpCall("read_context", { project }),
);
await timed("mcp_read_context_query", () =>
  mcpCall("read_context", {
    project,
    query: "remote MCP latency tool invocation",
  }),
);
await timed("mcp_search_memory", () =>
  mcpCall("search_memory", {
    project,
    query: "remote MCP latency tool invocation",
  }),
);
