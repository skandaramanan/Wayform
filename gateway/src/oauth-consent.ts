/** Cloudflare securing-MCP cookie names: __Host- blocks subdomain attacks on workers.dev. */
export const CSRF_COOKIE = "__Host-CSRF_TOKEN";
export const CONSENTED_STATE_COOKIE = "__Host-CONSENTED_STATE";

const COOKIE_ATTRS = "HttpOnly; Secure; Path=/; SameSite=Lax";
const STATE_TTL_SECONDS = 600;

export interface OauthKv {
  put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ): Promise<void>;
}

export function generateCSRFProtection(): { token: string; setCookie: string } {
  const token = crypto.randomUUID();
  return {
    token,
    setCookie: `${CSRF_COOKIE}=${token}; ${COOKIE_ATTRS}; Max-Age=${STATE_TTL_SECONDS}`,
  };
}

export function validateCSRFToken(
  formData: FormData,
  request: Request,
): { clearCookie: string } {
  const tokenFromForm = formData.get("csrf_token");
  if (!tokenFromForm || typeof tokenFromForm !== "string") {
    throw new Error("CSRF token missing from form");
  }
  const tokenFromCookie = cookieValue(request, CSRF_COOKIE);
  if (!tokenFromCookie) {
    throw new Error("CSRF token cookie missing");
  }
  if (tokenFromForm !== tokenFromCookie) {
    throw new Error("CSRF token mismatch");
  }
  return {
    clearCookie: `${CSRF_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`,
  };
}

export function renderConsentPage(opts: {
  clientName: string;
  csrfToken: string;
  state: string;
}): string {
  const clientName = escapeHtml(opts.clientName);
  const csrfToken = escapeHtml(opts.csrfToken);
  const state = escapeHtml(opts.state);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Wayform</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.25rem; color: #111; }
    h1 { font-size: 1.35rem; }
    p { line-height: 1.45; color: #333; }
    button { font: inherit; padding: 0.55rem 1rem; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Connect to Wayform</h1>
  <p><strong>${clientName}</strong> wants to access this team's memory via MCP. Authorize only if you started this from Cursor, Claude, or Codex.</p>
  <form method="post" action="/authorize">
    <input type="hidden" name="csrf_token" value="${csrfToken}">
    <input type="hidden" name="state" value="${state}">
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
}

export function githubAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  return url.toString();
}

export async function createOAuthState(
  oauthReqInfo: unknown,
  kv: OauthKv,
  ttl = STATE_TTL_SECONDS,
): Promise<{ stateToken: string }> {
  const stateToken = crypto.randomUUID();
  await kv.put(`oauth:state:${stateToken}`, JSON.stringify(oauthReqInfo), {
    expirationTtl: ttl,
  });
  return { stateToken };
}

export async function bindStateToSession(
  stateToken: string,
): Promise<{ setCookie: string }> {
  const hashHex = await sha256Hex(stateToken);
  return {
    setCookie: `${CONSENTED_STATE_COOKIE}=${hashHex}; ${COOKIE_ATTRS}; Max-Age=${STATE_TTL_SECONDS}`,
  };
}

export function encodeAuthState(oauthReqInfo: unknown): string {
  return btoa(JSON.stringify(oauthReqInfo));
}

export function decodeAuthState(encoded: string): unknown {
  return JSON.parse(atob(encoded));
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
