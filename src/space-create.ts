/**
 * `wayform space create` — Plan C: automates the operator flow for standing
 * up a new hosted space (repo creation, GitHub App install detection, member
 * token mint). Operator-only: requires WAYFORM_ADMIN_SECRET, the same shared
 * credential the manual `curl` flow against POST /admin/members already uses.
 */
import { execFileSync } from "node:child_process";

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const has = (args: string[], name: string): boolean =>
  args.includes(`--${name}`);

export interface SpaceCreateArgs {
  space: string;
  owner: string;
  repo: string;
  isPublic: boolean;
  appSlug: string;
  author?: string;
  authorEmail?: string;
}

export function parseSpaceCreateArgs(args: string[]): SpaceCreateArgs {
  const space = flag(args, "space");
  const owner = flag(args, "owner");
  const repo = flag(args, "repo");
  if (!space || !owner || !repo) {
    throw new Error(
      "wayform space create requires --space <name> --owner <owner> --repo <repo>",
    );
  }
  const appSlug = flag(args, "app-slug") ?? process.env.WAYFORM_GITHUB_APP_SLUG;
  if (!appSlug) {
    throw new Error(
      "wayform space create requires --app-slug <slug> or WAYFORM_GITHUB_APP_SLUG " +
        "(the GitHub App's slug, used to build the install URL)",
    );
  }
  return {
    space,
    owner,
    repo,
    isPublic: has(args, "public"),
    appSlug,
    author: flag(args, "author"),
    authorEmail: flag(args, "author-email"),
  };
}

export function resolveAdminSecret(): string {
  const secret = process.env.WAYFORM_ADMIN_SECRET;
  if (!secret) {
    throw new Error(
      "WAYFORM_ADMIN_SECRET is not set. `wayform space create` is an " +
        "operator-only command — export the gateway's ADMIN_SECRET before running it.",
    );
  }
  return secret;
}

export type Runner = (cmd: string, args: string[]) => void;

const defaultRunner: Runner = (cmd, args) =>
  // Bounded + non-interactive, same posture as init-remote's registerClaudeCodeMcp:
  // a hanging or prompting child process must never freeze space create.
  void execFileSync(cmd, args, {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 15000,
  });

export function ghAuthenticated(run: Runner = defaultRunner): boolean {
  try {
    run("gh", ["auth", "status"]);
    return true;
  } catch {
    return false;
  }
}

export function createRepoWithGh(
  owner: string,
  repo: string,
  isPublic: boolean,
  run: Runner = defaultRunner,
): void {
  run("gh", [
    "repo",
    "create",
    `${owner}/${repo}`,
    isPublic ? "--public" : "--private",
  ]);
}

/**
 * Tries the org repo-creation endpoint first, falls back to /user/repos on a
 * 404 (the owner isn't an org this token can create under — the common case
 * when --owner is the token holder's own username).
 */
export async function createRepoWithPat(
  owner: string,
  repo: string,
  isPublic: boolean,
  pat: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const body = JSON.stringify({ name: repo, private: !isPublic });
  const headers = {
    authorization: `Bearer ${pat}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "wayform-cli",
  };
  let res = await fetchImpl(`https://api.github.com/orgs/${owner}/repos`, {
    method: "POST",
    headers,
    body,
  });
  if (res.status === 404) {
    res = await fetchImpl("https://api.github.com/user/repos", {
      method: "POST",
      headers,
      body,
    });
  }
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`GitHub repo creation failed (${res.status}): ${detail}`);
  }
}

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
}

const DEFAULT_POLL: PollOptions = { intervalMs: 3000, timeoutMs: 120_000 };
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function pollInstallation(
  gatewayUrl: string,
  adminSecret: string,
  owner: string,
  fetchImpl: typeof fetch = fetch,
  opts: PollOptions = DEFAULT_POLL,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<number> {
  const deadline = Date.now() + opts.timeoutMs;
  const url = `${gatewayUrl}/admin/installations?owner=${encodeURIComponent(owner)}`;
  const manualFallback =
    `curl -X POST ${gatewayUrl}/admin/members -H "x-admin-secret: <secret>" ` +
    `-H "content-type: application/json" -d '{"space":"...","installationId":<id>,` +
    `"owner":"${owner}","repo":"...","author":"...","authorEmail":"..."}'`;

  while (true) {
    const res = await fetchImpl(url, {
      headers: { "x-admin-secret": adminSecret },
    });
    if (res.status === 200) {
      const body = (await res.json()) as { installationId: number };
      return body.installationId;
    }
    if (res.status === 409) {
      const body = (await res.json()) as { installationIds: number[] };
      throw new Error(
        `Multiple GitHub App installations found for owner "${owner}" ` +
          `(${body.installationIds.join(", ")}). Resolve manually, then mint the ` +
          `token directly:\n  ${manualFallback}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for the GitHub App install on "${owner}". Install it, ` +
          `then mint the token manually:\n  ${manualFallback}`,
      );
    }
    await sleep(opts.intervalMs);
  }
}
