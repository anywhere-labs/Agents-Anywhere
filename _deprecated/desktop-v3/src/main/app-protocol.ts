// The `app://aa/` protocol: serves the bundled web-v3 static export and proxies control-plane HTTP.
//
// Static export (`AA_DESKTOP_EXPORT=1`) pre-renders dynamic routes once for the placeholder param `_`
// (`web-v3/lib/platform/export-params.ts`); every concrete id is served that page and its RSC payloads, and the
// page reads the real ids from the URL.
//
// Control plane: `/api/control/*` goes to the configured control URL (what a web deployment's Next.js rewrite
// does), `/api/remote?url=…` to any absolute http(s) URL the user signed in with. Both run in the main process,
// so the renderer needs no CORS allowance from the control plane.

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

export const APP_SCHEME = "app";
export const APP_HOST = "aa";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** Dynamic route prefixes and how many leading id segments each has. */
const DYNAMIC_ROUTES: { prefix: string; ids: number }[] = [
  { prefix: "devices", ids: 1 },
  { prefix: "sessions", ids: 2 },
];
const PLACEHOLDER = "_";
const PAYLOAD_EXT = /\.(txt|html)$/u;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/x-component",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Map a URL path to the export-relative path segments, replacing concrete ids of dynamic routes with the
 * placeholder. `/sessions/dev_1/ses_2.txt` → `["sessions", "_", "_.txt"]`.
 */
export function mapDynamicSegments(pathname: string): string[] {
  const segments = pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const route = DYNAMIC_ROUTES.find((r) => r.prefix === segments[0]);
  if (!route || segments.length < 1 + route.ids) return segments;
  for (let i = 1; i <= route.ids; i++) {
    const segment = segments[i]!;
    const isLast = i === segments.length - 1;
    const ext = isLast ? (PAYLOAD_EXT.exec(segment)?.[0] ?? "") : "";
    segments[i] = `${PLACEHOLDER}${ext}`;
  }
  return segments;
}

export interface StaticHit {
  file: string;
  status: 200 | 404;
}

/** Resolve a request path to a file inside `root` (the static export), or the 404 page. */
export function resolveStaticFile(root: string, pathname: string): StaticHit | null {
  const segments = mapDynamicSegments(pathname);
  if (segments.some((s) => s === ".." || s.includes("\\") || s.includes("\0"))) return null;
  const rel = segments.join("/");
  const candidates = rel === "" ? ["index.html"] : path.extname(rel) ? [rel] : [`${rel}.html`, `${rel}/index.html`];
  const base = path.resolve(root);
  for (const candidate of candidates) {
    const full = path.resolve(base, candidate);
    if (full !== base && !full.startsWith(base + path.sep)) return null;
    if (isFile(full)) return { file: full, status: 200 };
  }
  const notFound = path.join(base, "404.html");
  return isFile(notFound) ? { file: notFound, status: 404 } : null;
}

function isFile(file: string): boolean {
  try {
    return existsSync(file) && statSync(file).isFile();
  } catch {
    return false;
  }
}

export async function serveStatic(root: string, pathname: string): Promise<Response> {
  const hit = resolveStaticFile(root, pathname);
  if (!hit) return new Response("Not found", { status: 404 });
  const body = await readFile(hit.file);
  const headers: Record<string, string> = {
    "content-type": contentTypeFor(hit.file),
    "x-content-type-options": "nosniff",
    "cache-control": hit.file.includes(`${path.sep}_next${path.sep}static${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
  };
  return new Response(body, { status: hit.status, headers });
}

// ── Control-plane proxy ───────────────────────────────────────────────────────────────────────────────────────

const HOP_HEADERS = new Set([
  "host",
  "origin",
  "referer",
  "cookie",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);
const STRIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"]);

/**
 * The upstream URL for a proxied control-plane request, or null when `url` is not a proxy path.
 * Throws when a `/api/remote` target is not an absolute http(s) URL.
 */
export function controlProxyTarget(url: URL, controlUrl: string): string | null {
  if (url.pathname === "/api/control" || url.pathname.startsWith("/api/control/")) {
    const base = controlUrl.replace(/\/+$/u, "");
    if (!/^https?:\/\//u.test(base)) throw new Error("the control server URL is not set");
    return `${base}${url.pathname.slice("/api/control".length)}${url.search}`;
  }
  if (url.pathname === "/api/remote") {
    const target = url.searchParams.get("url") ?? "";
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      throw new Error("invalid proxy target");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid proxy target");
    return parsed.toString();
  }
  return null;
}

export type FetchLike = (input: string, init: RequestInit & { duplex?: "half" }) => Promise<Response>;

export async function proxyRequest(request: Request, target: string, fetchImpl: FetchLike): Promise<Response> {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
      method: request.method,
      headers,
      ...(hasBody ? { body: request.body, duplex: "half" as const } : {}),
      redirect: "manual",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ code: "control_unreachable", detail: `Cannot reach the control server: ${message}` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) out.set(key, value);
  });
  const nullBody = [101, 204, 205, 304].includes(upstream.status);
  return new Response(nullBody ? null : upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}
