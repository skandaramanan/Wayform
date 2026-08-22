import type { Env } from "./env.js";
import type { GithubIdentity, GithubInstallation } from "./spaces.js";
import { installationToken } from "./github-auth.js";
import type { SetupRepository } from "./setup.js";

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

export async function fetchInstallationRepositories(
  env: Env,
  installationId: number,
  fetchImpl: typeof fetch = env.githubFetch ?? fetch,
): Promise<SetupRepository[]> {
  const token = await installationToken(env, installationId, fetchImpl);
  const res = await fetchImpl(
    "https://api.github.com/installation/repositories?per_page=100",
    { headers: githubHeaders(token) },
  );
  if (!res.ok) {
    throw new Error(`installation repositories failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    repositories?: Array<{
      name?: string;
      owner?: { login?: string };
      private?: boolean;
      default_branch?: string | null;
    }>;
  };
  return (body.repositories ?? [])
    .filter(
      (
        repo,
      ): repo is {
        name: string;
        owner: { login: string };
        private?: boolean;
        default_branch?: string | null;
      } => Boolean(repo.name && repo.owner?.login),
    )
    .map((repo) => ({
      owner: repo.owner.login,
      repo: repo.name,
      private: repo.private === true,
      defaultBranch: repo.default_branch?.trim() || null,
    }));
}

export async function validateMemoryRepository(
  env: Env,
  installationId: number,
  repository: SetupRepository,
  fetchImpl: typeof fetch = env.githubFetch ?? fetch,
): Promise<void> {
  if (!repository.private) {
    throw new Error("Wayform memory repositories must be private.");
  }
  if (!repository.defaultBranch) {
    throw new Error(
      "Initialize the memory repository with a first commit before selecting it.",
    );
  }
  const token = await installationToken(env, installationId, fetchImpl);
  const owner = encodeURIComponent(repository.owner);
  const repo = encodeURIComponent(repository.repo);
  const branch = repository.defaultBranch
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const res = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`,
    { headers: githubHeaders(token) },
  );
  if (!res.ok) {
    throw new Error(
      "The selected repository branch is unavailable to the GitHub App.",
    );
  }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "memorylayer-gateway",
  };
}
