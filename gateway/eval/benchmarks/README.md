# Baseline benchmarks (remote MCP only)

Product plane is the **hosted gateway**. Do not measure local stdio MCP.

## Scripts

| Script | Purpose |
|--------|---------|
| `latency.mjs` | p50/p95 for `/hook/read`, `/api/read`, MCP `read_context` / `search_memory` |
| `invocation-rate.mjs` + `invocation-prompts.json` | Soft-write / search should-trigger fixtures (method from memory `16fa6187`) |

## Env

```bash
export MEMORYLAYER_GATEWAY_URL=https://your-gateway
# short-lived OAuth access token from `wayform login` (never commit)
export MEMORYLAYER_GATEWAY_TOKEN=…access_token…
node gateway/eval/benchmarks/latency.mjs --project memorylayer --runs 5
node gateway/eval/benchmarks/invocation-rate.mjs
# optional auto-run:
CLAUDE_BIN=claude node gateway/eval/benchmarks/invocation-rate.mjs --runs 3
```

## Mining `retrieval_log` (D1)

No new code required. In the Cloudflare dashboard or `wrangler d1 execute`:

```sql
SELECT trigger, COUNT(*) AS n, AVG(LENGTH(query)) AS avg_q
FROM retrieval_log
WHERE ts > datetime('now', '-7 days')
GROUP BY trigger
ORDER BY n DESC;
```

Use this to see real mid-session pull patterns vs session hook traffic.

## Targets (plan)

- Soft-write should-trigger ≥ 80%, false-positive ~0%
- Queryless gateway read: warm p95 < 500ms; cold p95 ≪ multi-second GitHub fan-out after warm-store
- Golden recall@10 ≥ 0.9 unchanged (`npm run test:gateway`)
