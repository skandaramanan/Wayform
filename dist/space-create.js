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
const flag = (args, name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const has = (args, name) => args.includes(`--${name}`);
export function parseSpaceCreateArgs(args) {
    const space = flag(args, "space");
    const owner = flag(args, "owner");
    const repo = flag(args, "repo");
    if (!space || !owner || !repo) {
        throw new Error("wayform space create requires --space <name> --owner <owner> --repo <repo>");
    }
    const appSlug = flag(args, "app-slug") ?? process.env.WAYFORM_GITHUB_APP_SLUG;
    if (!appSlug) {
        throw new Error("wayform space create requires --app-slug <slug> or WAYFORM_GITHUB_APP_SLUG " +
            "(the GitHub App's slug, used to build the install URL)");
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
export function resolveAdminSecret() {
    const secret = process.env.WAYFORM_ADMIN_SECRET;
    if (!secret) {
        throw new Error("WAYFORM_ADMIN_SECRET is not set. `wayform space create` is an " +
            "operator-only command — export the gateway's ADMIN_SECRET before running it.");
    }
    return secret;
}
const defaultRunner = (cmd, args) => 
// Bounded + non-interactive, same posture as init-remote's registerClaudeCodeMcp:
// a hanging or prompting child process must never freeze space create.
void execFileSync(cmd, args, {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 15000,
});
export function ghAuthenticated(run = defaultRunner) {
    try {
        run("gh", ["auth", "status"]);
        return true;
    }
    catch {
        return false;
    }
}
export function createRepoWithGh(owner, repo, isPublic, run = defaultRunner) {
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
export async function createRepoWithPat(owner, repo, isPublic, pat, fetchImpl = fetch) {
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
const DEFAULT_POLL = { intervalMs: 3000, timeoutMs: 120_000 };
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function pollInstallation(gatewayUrl, adminSecret, owner, fetchImpl = fetch, opts = DEFAULT_POLL, sleep = defaultSleep) {
    const deadline = Date.now() + opts.timeoutMs;
    const url = `${gatewayUrl}/admin/installations?owner=${encodeURIComponent(owner)}`;
    const manualFallback = `curl -X POST ${gatewayUrl}/admin/members -H "x-admin-secret: <secret>" ` +
        `-H "content-type: application/json" -d '{"space":"...","installationId":<id>,` +
        `"owner":"${owner}","repo":"...","author":"...","authorEmail":"..."}'`;
    while (true) {
        const res = await fetchImpl(url, {
            headers: { "x-admin-secret": adminSecret },
        });
        if (res.status === 200) {
            const body = (await res.json());
            return body.installationId;
        }
        if (res.status === 409) {
            const body = (await res.json());
            throw new Error(`Multiple GitHub App installations found for owner "${owner}" ` +
                `(${body.installationIds.join(", ")}). Resolve manually, then mint the ` +
                `token directly:\n  ${manualFallback}`);
        }
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for the GitHub App install on "${owner}". Install it, ` +
                `then mint the token manually:\n  ${manualFallback}`);
        }
        await sleep(opts.intervalMs);
    }
}
export async function mintMemberToken(gatewayUrl, adminSecret, body, fetchImpl = fetch) {
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
    return (await res.json());
}
export async function promptForPat() {
    const rl = readline.createInterface({ input, output });
    const pat = await rl.question("gh not found or not authenticated. Paste a GitHub PAT with repo-creation scope: ");
    rl.close();
    return pat.trim();
}
const defaultDeps = {
    run: defaultRunner,
    fetchImpl: fetch,
    promptForPat,
    sleep: defaultSleep,
    log: (msg) => console.log(msg),
    poll: DEFAULT_POLL,
};
export async function runSpaceCreate(args, deps = {}) {
    const d = { ...defaultDeps, ...deps };
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
    }
    else {
        const pat = await d.promptForPat();
        await createRepoWithPat(parsed.owner, parsed.repo, parsed.isPublic, pat, d.fetchImpl);
    }
    d.log(`Repo created. Install the GitHub App: https://github.com/apps/${parsed.appSlug}/installations/new`);
    d.log("Waiting for the App to be installed...");
    const installationId = await pollInstallation(gatewayUrl, adminSecret, parsed.owner, d.fetchImpl, d.poll, d.sleep);
    d.log(`Detected installation ${installationId}. Minting member token...`);
    const minted = await mintMemberToken(gatewayUrl, adminSecret, {
        space: parsed.space,
        installationId,
        owner: parsed.owner,
        repo: parsed.repo,
        author,
        authorEmail,
    }, d.fetchImpl);
    d.log("");
    d.log(`Space "${parsed.space}" created.`);
    d.log(`Token (shown once): ${minted.token}`);
    d.log("");
    d.log("Hand this to each teammate:");
    d.log(`  wayform init --remote --gateway ${gatewayUrl} --token ${minted.token}`);
}
//# sourceMappingURL=space-create.js.map