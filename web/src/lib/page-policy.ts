// The built page's Content-Security-Policy. GitHub Pages cannot send headers. The build puts the policy in a meta tag (web/vite.config.ts).
// A meta policy cannot set frame-ancestors. The app checks for a frame itself (main.tsx).
// The desktop package adds its own header policy (launcher/serve.mjs). A browser applies both.

const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i;
const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/;

/** The origin of each URL the page reads, without repeats. Public hosts must use https. Plain http only reaches a chain on this computer. */
export function readOrigins(urls: readonly string[]): string[] {
  const origins = urls.map((url) => new URL(url).origin);
  const refused = origins.find((origin) => !HTTPS_ORIGIN.test(origin) && !LOCAL_ORIGIN.test(origin));
  if (refused) throw new Error(`The page may not read from ${refused}`);
  return [...new Set(origins)];
}

/** Scripts, styles, fonts and images come from this site only. Network reads go to this site and the given origins.
  * No plugins, base URL or form targets. Trusted Types stop scripts from writing HTML or script URLs as plain strings. */
export function pagePolicy(connect: readonly string[]): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    ["connect-src 'self'", ...connect].join(" "),
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join("; ");
}

/** Puts the policy right after the charset. The policy then covers everything the page loads. */
export function withPagePolicy(html: string, policy: string): string {
  if (/["<>&]/.test(policy)) throw new Error("A page policy never holds a quote mark or markup");
  const charset = /<meta charset="UTF-8" \/>(\s*)/i.exec(html);
  if (!charset) throw new Error("The page has no charset meta tag to put its policy after");
  const at = charset.index + charset[0].length;
  return `${html.slice(0, at)}<meta http-equiv="Content-Security-Policy" content="${policy}" />${charset[1]}${html.slice(at)}`;
}
