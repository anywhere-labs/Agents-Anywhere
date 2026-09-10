import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import config from "../config.json";
import type { DesktopServerConnection } from "./desktop-server";

export const DESKTOP_OAUTH_PROTOCOL = config.oauth.protocol;
export const DESKTOP_OAUTH_CLIENT_ID = config.oauth.clientId;
export const DESKTOP_OAUTH_REDIRECT_URI = config.oauth.redirectUri;
export const DESKTOP_OAUTH_SCOPE = config.oauth.scope;

const DESKTOP_OAUTH_REQUEST_TTL_MS = config.oauth.requestTtlMs;

export type DesktopOAuthPending = {
  state: string;
  verifier: string;
  createdAt: number;
};

export type DesktopOAuthResult =
  | { status: "success"; accessToken: string; server: DesktopServerConnection }
  | { status: "error"; error: string };

export async function exchangeDesktopOAuthCode(
  code: string,
  verifier: string,
  server: DesktopServerConnection,
  fetcher: typeof fetch,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.oauth.tokenTimeoutMs);
  try {
    const response = await fetcher(`${server.serverUrl}${server.apiNamespace}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      credentials: "omit",
      redirect: "error",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: DESKTOP_OAUTH_CLIENT_ID,
        redirect_uri: DESKTOP_OAUTH_REDIRECT_URI,
        code_verifier: verifier,
      }).toString(),
      signal: controller.signal,
    });
    const payload = await response.json() as { access_token?: unknown; detail?: unknown };
    if (!response.ok) {
      throw new Error(typeof payload.detail === "string" ? payload.detail : `Desktop login failed (${response.status}).`);
    }
    if (typeof payload.access_token !== "string" || !payload.access_token) {
      throw new Error("Desktop login token response was invalid.");
    }
    return payload.access_token;
  } finally {
    clearTimeout(timeout);
  }
}

export function createDesktopOAuthRequest(
  webOrigin: string,
  now = Date.now(),
): { authorizeUrl: string; pending: DesktopOAuthPending } {
  const origin = normalizeWebOrigin(webOrigin);
  const verifier = randomBytes(48).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: DESKTOP_OAUTH_CLIENT_ID,
    redirect_uri: DESKTOP_OAUTH_REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: DESKTOP_OAUTH_SCOPE,
    state,
  });
  return {
    authorizeUrl: `${origin}/#${config.oauth.route}?${params.toString()}`,
    pending: { state, verifier, createdAt: now },
  };
}

export function desktopOAuthCodeFromCallback(
  rawUrl: string,
  pending: DesktopOAuthPending | null,
  now = Date.now(),
): string {
  const url = new URL(rawUrl);
  if (
    url.protocol !== `${DESKTOP_OAUTH_PROTOCOL}:` ||
    url.hostname !== "oauth" ||
    url.pathname !== "/callback"
  ) {
    throw new Error("Unsupported Desktop OAuth callback.");
  }
  if (!pending || now - pending.createdAt > DESKTOP_OAUTH_REQUEST_TTL_MS) {
    throw new Error("Desktop login request expired. Start sign-in again.");
  }

  const state = url.searchParams.get("state");
  if (!state || !secureEqual(state, pending.state)) {
    throw new Error("Desktop login state did not match. Start sign-in again.");
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const description = url.searchParams.get("error_description");
    throw new Error(description || `Desktop login was rejected: ${oauthError}`);
  }
  const code = url.searchParams.get("code");
  if (!code) throw new Error("Desktop login callback did not include a code.");
  return code;
}

export function desktopOAuthUrlFromArgv(argv: readonly string[]): string | null {
  return argv.find((value) => isDesktopOAuthCallback(value)) ?? null;
}

/** The scheme also carries onboarding entries, which must never reach the OAuth queue. */
export function isDesktopOAuthCallback(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === `${DESKTOP_OAUTH_PROTOCOL}:` && url.hostname === "oauth";
  } catch {
    return false;
  }
}

function normalizeWebOrigin(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("Desktop OAuth Web origin must be an http(s) URL without credentials.");
  }
  return url.origin;
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
