const REMOTE_TIMEOUT_MS = 4000;
function configured(cfg) {
    return Boolean(cfg.gatewayUrl && cfg.gatewayToken);
}
export async function remoteApiRead(cfg, opts, fetchImpl = fetch) {
    if (!configured(cfg))
        return null;
    try {
        const url = new URL(`${cfg.gatewayUrl}/api/read`);
        url.searchParams.set("project", opts.project);
        if (opts.query)
            url.searchParams.set("query", opts.query);
        if (opts.budgetTokens)
            url.searchParams.set("budget", String(opts.budgetTokens));
        if (opts.kinds?.length)
            url.searchParams.set("kinds", opts.kinds.join(","));
        if (opts.trigger)
            url.searchParams.set("trigger", opts.trigger);
        const res = await fetchImpl(url.toString(), {
            headers: { authorization: `Bearer ${cfg.gatewayToken}` },
            signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
        });
        if (!res.ok)
            return null;
        const body = (await res.json());
        if (typeof body.text !== "string" || typeof body.total !== "number")
            return null;
        return {
            text: body.text,
            total: body.total,
            matched: typeof body.matched === "number" ? body.matched : 0,
        };
    }
    catch {
        return null;
    }
}
export async function remoteHookRead(cfg, project, budgetTokens, fetchImpl = fetch) {
    if (!configured(cfg))
        return null;
    try {
        const url = new URL(`${cfg.gatewayUrl}/hook/read`);
        url.searchParams.set("project", project);
        url.searchParams.set("budget", String(budgetTokens));
        const res = await fetchImpl(url.toString(), {
            headers: { authorization: `Bearer ${cfg.gatewayToken}` },
            signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
        });
        if (!res.ok)
            return null;
        return await res.text();
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=remote-read.js.map