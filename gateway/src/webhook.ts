/**
 * POST /webhook/github — GitHub App push webhook, the ingest path for
 * local-plane writes (§2): a member's `git push` lands here seconds later and
 * updates the one remote index. Signature-checked (HMAC SHA-256), branch- and
 * repo-filtered via the spaces registry, fail-open: every non-error outcome
 * is a 2xx so GitHub does not retry-storm, and ingest failures are swallowed
 * (the cron reconciler catches them via last_indexed_sha drift).
 */
import type { Env } from "./env.js";
import { getSpaceRepo } from "./tenancy.js";
import { indexDeps } from "./deps.js";
import { ingestFiles } from "./ingest.js";

export async function verifyGithubSignature(
  secret: string,
  body: string,
  sigHeader: string | null,
): Promise<boolean> {
  if (!sigHeader?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const given = sigHeader.slice("sha256=".length).toLowerCase();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0;
}

interface PushPayload {
  ref?: string;
  after?: string;
  repository?: { full_name?: string };
  commits?: { added?: string[]; modified?: string[] }[];
}

export async function handleWebhook(
  req: Request,
  env: Env,
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  const body = await req.text();
  if (
    !env.WEBHOOK_SECRET ||
    !(await verifyGithubSignature(
      env.WEBHOOK_SECRET,
      body,
      req.headers.get("x-hub-signature-256"),
    ))
  ) {
    return new Response("bad signature", { status: 401 });
  }
  if (req.headers.get("x-github-event") !== "push") {
    return new Response("ignored event", { status: 200 });
  }

  let payload: PushPayload;
  try {
    payload = JSON.parse(body) as PushPayload;
  } catch {
    return new Response("bad payload", { status: 400 });
  }

  const fullName = payload.repository?.full_name ?? "";
  const sr = await getSpaceRepo(env, fullName);
  if (!sr) return new Response("unknown repo", { status: 200 });
  if (payload.ref !== `refs/heads/${sr.branch}`) {
    return new Response("ignored ref", { status: 200 });
  }
  const deps = indexDeps(env);
  if (!deps || !payload.after) {
    return new Response("index disabled", { status: 200 });
  }

  const paths = [
    ...new Set(
      (payload.commits ?? []).flatMap((c) => [
        ...(c.added ?? []),
        ...(c.modified ?? []),
      ]),
    ),
  ];
  const after = payload.after;
  const work = ingestFiles(
    env,
    deps.db,
    deps.embed,
    null, // gen wired to deps.gen in Task 5
    sr,
    paths,
    after,
    env.githubFetch ?? fetch,
  ).catch(() => {
    // swallowed: reconcile cron detects the sha gap and reindexes
  });
  if (ctx) {
    ctx.waitUntil(work);
    return new Response("accepted", { status: 202 });
  }
  await work;
  return new Response("ok", { status: 200 });
}
