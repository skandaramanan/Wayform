/**
 * `wayform space create` — Plan C: automates the operator flow for standing
 * up a new hosted space (repo creation, GitHub App install detection, member
 * token mint). Operator-only: requires WAYFORM_ADMIN_SECRET, the same shared
 * credential the manual `curl` flow against POST /admin/members already uses.
 */
import { execFileSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { gitConfigDefault } from "./init-env.js";

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

export interface MintedMember {
  token: string;
  member: {
    space: string;
    installationId: number;
    owner: string;
    repo: string;
    branch: string;
    author: string;
    authorEmail: string;
  };
}

export async function mintMemberToken(
  gatewayUrl: string,
  adminSecret: string,
  body: {
    space: string;
    installationId: number;
    owner: string;
    repo: string;
    author: string;
    authorEmail: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<MintedMember> {
  const res = await fetchImpl(`${gatewayUrl}/admin/members`, {
    method: "POST",
    headers: {
      "x-admin-secret": adminSecret,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`token mint failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as MintedMember;
}

export async function createTeamInvite(
  gatewayUrl: string,
  adminSecret: string,
  body: {
    space: string;
    installationId: number;
    owner: string;
    repo: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`${gatewayUrl}/admin/invites`, {
    method: "POST",
    headers: {
      "x-admin-secret": adminSecret,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`invite mint failed (${res.status}): ${detail}`);
  }
  const { invite } = (await res.json()) as { invite: string };
  return invite;
}

export async function promptForPat(): Promise<string> {
  const rl = readline.createInterface({ input, output });
  const pat = await rl.question(
    "gh not found or not authenticated. Paste a GitHub PAT with repo-creation scope: ",
  );
  rl.close();
  return pat.trim();
}

export interface SpaceCreateDeps {
  run: Runner;
  fetchImpl: typeof fetch;
  promptForPat: () => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
  poll: PollOptions;
}

const defaultDeps: SpaceCreateDeps = {
  run: defaultRunner,
  fetchImpl: fetch,
  promptForPat,
  sleep: defaultSleep,
  log: (msg) => console.log(msg),
  poll: DEFAULT_POLL,
};

export async function runSpaceCreate(
  args: string[],
  deps: Partial<SpaceCreateDeps> = {},
): Promise<void> {
  const d: SpaceCreateDeps = { ...defaultDeps, ...deps };
  const parsed = parseSpaceCreateArgs(args);
  const gatewayUrl = (flag(args, "gateway") ?? "").replace(/\/+$/, "");
  if (!gatewayUrl) {
    throw new Error("wayform space create requires --gateway <url>");
  }
  const adminSecret = resolveAdminSecret();
  const author = parsed.author ?? gitConfigDefault("user.name");
  const authorEmail = parsed.authorEmail ?? gitConfigDefault("user.email");

  d.log(`Creating repo ${parsed.owner}/${parsed.repo}...`);
  if (ghAuthenticated(d.run)) {
    createRepoWithGh(parsed.owner, parsed.repo, parsed.isPublic, d.run);
  } else {
    const pat = await d.promptForPat();
    await createRepoWithPat(
      parsed.owner,
      parsed.repo,
      parsed.isPublic,
      pat,
      d.fetchImpl,
    );
  }

  d.log(
    `Repo created. Install the GitHub App: https://github.com/apps/${parsed.appSlug}/installations/new`,
  );
  d.log("Waiting for the App to be installed...");
  const installationId = await pollInstallation(
    gatewayUrl,
    adminSecret,
    parsed.owner,
    d.fetchImpl,
    d.poll,
    d.sleep,
  );

  d.log(`Detected installation ${installationId}. Minting member token...`);
  const minted = await mintMemberToken(
    gatewayUrl,
    adminSecret,
    {
      space: parsed.space,
      installationId,
      owner: parsed.owner,
      repo: parsed.repo,
      author,
      authorEmail,
    },
    d.fetchImpl,
  );

  const invite = await createTeamInvite(
    gatewayUrl,
    adminSecret,
    {
      space: parsed.space,
      installationId,
      owner: parsed.owner,
      repo: parsed.repo,
    },
    d.fetchImpl,
  );

  d.log("");
  d.log(`Space "${parsed.space}" created.`);
  d.log(`Your token (shown once): ${minted.token}`);
  d.log("");
  d.log("Hand this ONE line to each teammate — each mints their own token");
  d.log("(invite expires in 14 days / 25 uses; send via email or a Slack");
  d.log("code block, never iMessage — it mangles the dashes):");
  d.log(
    `  wayform init --remote --gateway ${gatewayUrl} --invite ${invite}`,
  );
}
