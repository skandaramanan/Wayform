import type { Env } from "./env.js";
import type { GithubIdentity, GithubInstallation } from "./spaces.js";

export async function exchangeGithubCode(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<string> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new Error("GitHub OAuth is not configured");
  }
  const fetchImpl = env.githubFetch ?? fetch;
  const res = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "memorylayer-gateway",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`github token exchange failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    access_token?: string;
    error?: string;
  };
  if (!body.access_token) {
    throw new Error(body.error ?? "github token missing");
  }
  return body.access_token;
}

export async function fetchGithubUser(
  token: string,
  fetchImpl: typeof fetch,
): Promise<GithubIdentity> {
  const res = await fetchImpl("https://api.github.com/user", {
    headers: githubHeaders(token),
  });
  if (!res.ok) throw new Error(`github user failed: ${res.status}`);
  const user = (await res.json()) as {
    id?: number;
    login?: string;
    email?: string | null;
  };
  if (!user.id || !user.login) throw new Error("github user incomplete");
  return { id: user.id, login: user.login, email: user.email };
}

export async function fetchGithubInstallations(
  token: string,
  fetchImpl: typeof fetch,
): Promise<GithubInstallation[]> {
  const res = await fetchImpl("https://api.github.com/user/installations", {
    headers: githubHeaders(token),
  });
  if (!res.ok) throw new Error(`github installations failed: ${res.status}`);
  const body = (await res.json()) as { installations?: GithubInstallation[] };
  return body.installations ?? [];
}

export async function fetchInstallationRepos(
  token: string,
  installationId: number,
  fetchImpl: typeof fetch,
): Promise<{ owner: string; repo: string }[]> {
  const res = await fetchImpl(
    `https://api.github.com/user/installations/${installationId}/repositories`,
    { headers: githubHeaders(token) },
  );
  if (!res.ok) return [];
  const body = (await res.json()) as {
    repositories?: { name?: string; owner?: { login?: string } }[];
  };
  return (body.repositories ?? [])
    .filter((r) => r.name && r.owner?.login)
    .map((r) => ({ owner: r.owner!.login!, repo: r.name! }));
}

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "memorylayer-gateway",
  };
}
