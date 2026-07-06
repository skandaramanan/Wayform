import type { Env } from "./env.js";

const enc = new TextEncoder();

/** Base64url (unpadded) over a string or bytes. */
export function b64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof data === "string"
      ? enc.encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * GitHub App JWT: RS256, 10-minute lifetime, iat backdated 60s for clock
 * drift (both per GitHub's App auth docs). Requires a PKCS#8 PEM — GitHub's
 * downloaded key is PKCS#1; the deploy runbook converts it via openssl.
 */
export async function appJwt(
  appId: string,
  privateKeyPem: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: nowSec - 60, exp: nowSec + 600, iss: appId }),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    enc.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

/**
 * Mint (or serve cached) a per-installation access token — the ONLY GitHub
 * credential the storage layer ever sees, scoped by GitHub itself to the one
 * repo the App is installed on. Cached 45 min (tokens live 60).
 */
export async function installationToken(
  env: Env,
  installationId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const cacheKey = `ghtok:${installationId}`;
  const cached = await env.ROUTING.get(cacheKey);
  if (cached) return cached;

  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const res = await fetchImpl(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "user-agent": "memorylayer-gateway",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`installation token exchange failed: ${res.status}`);
  }
  const body = (await res.json()) as { token: string };
  try {
    // Caching is best-effort: a KV failure here must not throw away an
    // already-minted GitHub token — the next call just re-mints instead.
    await env.ROUTING.put(cacheKey, body.token, { expirationTtl: 45 * 60 });
  } catch {
    // swallow: caller still gets the freshly minted token
  }
  return body.token;
}
