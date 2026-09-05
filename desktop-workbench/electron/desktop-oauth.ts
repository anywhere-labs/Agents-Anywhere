import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const DESKTOP_OAUTH_PROTOCOL = "agents-anywhere-desktop";
export const DESKTOP_OAUTH_CLIENT_ID = "agents-anywhere-desktop";
export const DESKTOP_OAUTH_REDIRECT_URI = `${DESKTOP_OAUTH_PROTOCOL}://oauth/callback`;
export const DESKTOP_OAUTH_SCOPE = "profile";

const DESKTOP_OAUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

export type DesktopOAuthPending = {
  state: string;
  verifier: string;
  createdAt: number;
};

export type DesktopOAuthResult =
  | { status: "success"; accessToken: string }
  | { status: "error"; error: string };

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
    authorizeUrl: `${origin}/#/desktop-oauth?${params.toString()}`,
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
  return argv.find((value) => value.startsWith(`${DESKTOP_OAUTH_PROTOCOL}:`)) ?? null;
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
