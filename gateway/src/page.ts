/**
 * The one HTML shell for every browser-facing gateway surface: the OAuth
 * consent screen, the App-install and repo-picker steps, the preview notice,
 * and every error dead end.
 *
 * These pages ARE the product's first impression — a member's first contact
 * with Wayform is an auth screen, not the CLI. Three near-identical <style>
 * blocks used to live in oauth-consent.ts and setup.ts and had already drifted
 * (32rem vs 36rem, different rules); errors rendered as bare browser text.
 *
 * Constraints that shape this file:
 *  - Self-contained. No external CSS, fonts, or images: an auth page must not
 *    leak the viewer to a third party, and a blocked CDN must not be able to
 *    render the consent screen unreadable.
 *  - Theme-aware. `color-scheme` plus a prefers-color-scheme token swap, so a
 *    dark-mode browser never gets a white slab.
 *  - No JavaScript. Consent must work with scripting disabled.
 */

/** Inline SVG favicon — a waypoint mark. Data URI so there is no second request. */
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="8" fill="#111114"/>' +
      '<path d="M8 20.5 13 11l3 5.5L19 11l5 9.5" fill="none" stroke="#fff" ' +
      'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>",
  );

const STYLES = `
  :root {
    color-scheme: light dark;
    --bg: #f6f6f7;
    --card: #ffffff;
    --border: #e4e4e7;
    --text: #18181b;
    --muted: #62626b;
    --accent: #111114;
    --accent-text: #ffffff;
    --danger: #b42318;
    --shadow: 0 1px 2px rgba(16,16,20,.04), 0 8px 24px rgba(16,16,20,.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0b0d;
      --card: #141417;
      --border: #26262c;
      --text: #f4f4f5;
      --muted: #a1a1aa;
      --accent: #f4f4f5;
      --accent-text: #111114;
      --danger: #f97066;
      --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.3);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem 1.25rem;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI",
          Roboto, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main {
    width: 100%;
    max-width: 30rem;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: var(--shadow);
    padding: 2rem;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: .55rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin-bottom: 1.5rem;
  }
  .brand svg { display: block; }
  h1 {
    font-size: 1.25rem;
    line-height: 1.3;
    letter-spacing: -0.015em;
    margin: 0 0 .6rem;
  }
  p { margin: 0 0 1rem; color: var(--muted); }
  p.lead { color: var(--text); }
  strong { color: var(--text); font-weight: 600; }
  ul.scopes {
    list-style: none;
    margin: 0 0 1.5rem;
    padding: .9rem 1rem;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg);
  }
  ul.scopes li {
    position: relative;
    padding-left: 1.4rem;
    margin: .35rem 0;
    color: var(--muted);
  }
  ul.scopes li::before {
    content: "";
    position: absolute;
    left: .15rem;
    top: .5rem;
    width: .5rem;
    height: .5rem;
    border-radius: 50%;
    background: var(--muted);
    opacity: .5;
  }
  label { display: block; padding: .3rem 0; color: var(--text); }
  input[type="radio"] { margin-right: .5rem; accent-color: var(--accent); }
  .actions { display: flex; gap: .6rem; align-items: center; margin-top: 1.5rem; }
  button, .btn {
    font: inherit;
    font-weight: 500;
    padding: .6rem 1.1rem;
    border-radius: 9px;
    border: 1px solid transparent;
    background: var(--accent);
    color: var(--accent-text);
    cursor: pointer;
    text-decoration: none;
    display: inline-block;
  }
  button:hover, .btn:hover { opacity: .88; }
  button:focus-visible, .btn:focus-visible, a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .btn-secondary {
    background: transparent;
    color: var(--muted);
    border-color: var(--border);
  }
  .note {
    margin: 1.5rem 0 0;
    padding-top: 1.15rem;
    border-top: 1px solid var(--border);
    font-size: .8125rem;
    color: var(--muted);
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: .875em;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: .1rem .35rem;
  }
  .err h1 { color: var(--danger); }
`;

const BRAND_MARK =
  '<svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">' +
  '<rect width="32" height="32" rx="8" fill="currentColor"/>' +
  '<path d="M8 20.5 13 11l3 5.5L19 11l5 9.5" fill="none" ' +
  'stroke="var(--card)" stroke-width="2.5" stroke-linecap="round" ' +
  'stroke-linejoin="round"/></svg>';

export interface PageOpts {
  /** Browser tab title; also the <h1> unless `heading` overrides it. */
  title: string;
  /** Body markup — already-escaped HTML. */
  body: string;
  heading?: string;
  /** Small print under a divider (recovery hints, support pointers). */
  note?: string;
  /** Renders the heading in the danger color. */
  variant?: "error";
}

export function page(opts: PageOpts): string {
  const heading = opts.heading ?? opts.title;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(opts.title)} · Wayform</title>
<link rel="icon" href="${FAVICON}">
<style>${STYLES}</style>
</head>
<body>
<main${opts.variant === "error" ? ' class="err"' : ""}>
<div class="brand">${BRAND_MARK}<span>Wayform</span></div>
<h1>${escapeHtml(heading)}</h1>
${opts.body}
${opts.note ? `<p class="note">${opts.note}</p>` : ""}
</main>
</body>
</html>`;
}

/**
 * A styled dead end instead of bare browser text.
 *
 * `message` is OUR copy, never an exception string: internal error text has no
 * meaning to the person reading it and can disclose gateway internals. Every
 * error page says what to do next, because the browser tab is a dead end —
 * the user cannot retry from here without being told how.
 */
export function errorPage(opts: {
  status: number;
  title: string;
  message: string;
  hint?: string;
}): Response {
  const html = page({
    title: opts.title,
    body: `<p class="lead">${escapeHtml(opts.message)}</p>`,
    note:
      opts.hint ??
      "Close this tab and start the connection again from your editor. " +
        "If it keeps failing, contact whoever sent you the Wayform URL.",
    variant: "error",
  });
  return new Response(html, {
    status: opts.status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
