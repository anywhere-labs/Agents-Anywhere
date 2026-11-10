/**
 * The Tokens Anywhere console embedded in the workbench.
 *
 * Tokens Anywhere lets a page be framed only by the Agents Anywhere instance
 * its embed ticket was issued to: it answers `frame-ancestors <instance>`
 * instead of `DENY`. The workbench renders from its own scheme, not the
 * instance's origin, so Chromium would refuse the frame. When, and only
 * when, the site has already allowed one explicit origin, the workbench adds
 * its own origins to that allowance. Every other answer (`'none'`, several
 * sources, `X-Frame-Options`) is left as it is.
 */

type Headers = Record<string, string[] | string>;

const SINGLE_ORIGIN = /^\s*frame-ancestors\s+(https?:\/\/[^\s;']+)\s*;?\s*$/i;

export function allowWorkbenchFrame(
  headers: Headers | undefined,
  workbenchOrigins: readonly string[],
): Headers | null {
  if (!headers || workbenchOrigins.length === 0) return null;
  const names = Object.keys(headers);
  if (names.some((name) => name.toLowerCase() === "x-frame-options")) return null;
  const cspNames = names.filter((name) => name.toLowerCase() === "content-security-policy");
  if (cspNames.length !== 1) return null;
  const raw = headers[cspNames[0]];
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length !== 1) return null;
  const match = SINGLE_ORIGIN.exec(values[0]);
  if (!match) return null;
  return {
    ...headers,
    [cspNames[0]]: [`frame-ancestors ${[match[1], ...workbenchOrigins].join(" ")}`],
  };
}
