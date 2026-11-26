// Pure helpers for the MCP OAuth 2.1 consent page (`app/oauth/authorize`).
//
// External MCP clients (Claude, Cursor, …) open `<web>/oauth/authorize?...` in the browser, either
// directly from the server's `authorization_endpoint` metadata or through the control plane's 302.
// Nothing here talks to the network: parsing, sign-in round-trips and redirect URLs only.

import type { McpConsentScopeView, McpScope } from "@/lib/types/v3"

export const CONSENT_PATH = "/oauth/authorize"

export interface AuthorizeRequest {
  clientId: string
  redirectUri: string
  scopes: string[]
  state: string | null
  codeChallenge: string
  codeChallengeMethod: "S256"
}

export type AuthorizeRequestError =
  | "missing_client_id"
  | "missing_redirect_uri"
  | "unsupported_response_type"
  | "missing_code_challenge"
  | "unsupported_code_challenge_method"

export type ParsedAuthorizeRequest =
  | { ok: true; request: AuthorizeRequest }
  | { ok: false; error: AuthorizeRequestError }

/** Parse and sanity-check the authorization request query (the server re-validates everything). */
export function parseAuthorizeQuery(params: URLSearchParams): ParsedAuthorizeRequest {
  const clientId = params.get("client_id")?.trim() ?? ""
  if (!clientId) return { ok: false, error: "missing_client_id" }
  const redirectUri = params.get("redirect_uri")?.trim() ?? ""
  if (!redirectUri) return { ok: false, error: "missing_redirect_uri" }
  const responseType = params.get("response_type")
  if (responseType !== null && responseType !== "code") {
    return { ok: false, error: "unsupported_response_type" }
  }
  // OAuth 2.1 makes PKCE mandatory and the control plane only accepts S256.
  const codeChallenge = params.get("code_challenge")?.trim() ?? ""
  if (!codeChallenge) return { ok: false, error: "missing_code_challenge" }
  const method = params.get("code_challenge_method") ?? "S256"
  if (method !== "S256") return { ok: false, error: "unsupported_code_challenge_method" }

  const scopes = (params.get("scope") ?? "").split(/\s+/).filter(Boolean)
  const state = params.get("state")
  return {
    ok: true,
    request: {
      clientId,
      redirectUri,
      scopes: [...new Set(scopes)],
      state: state === null || state === "" ? null : state,
      codeChallenge,
      codeChallengeMethod: "S256",
    },
  }
}

/**
 * Only same-origin absolute paths may be used as a post-sign-in destination
 * (rejects `https://…`, protocol-relative `//host` and `/\host`).
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/")) return null
  if (next.startsWith("//") || next.startsWith("/\\")) return null
  return next
}

/** `/sign-in` link that brings the user back to the exact consent URL afterwards. */
export function buildSignInHref(returnTo: string, options: { addAccount?: boolean } = {}): string {
  const params = new URLSearchParams()
  if (options.addAccount) params.set("add", "1")
  params.set("next", returnTo)
  return `/sign-in?${params.toString()}`
}

function appendQuery(redirectUri: string, query: Record<string, string>): string {
  try {
    const url = new URL(redirectUri)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    return url.toString()
  } catch {
    const hashIndex = redirectUri.indexOf("#")
    const base = hashIndex >= 0 ? redirectUri.slice(0, hashIndex) : redirectUri
    const sep = base.includes("?") ? "&" : "?"
    return `${base}${sep}${new URLSearchParams(query).toString()}`
  }
}

/**
 * RFC 6749 §4.1.2.1 `access_denied` response. Only call this with a redirect URI the server has
 * already confirmed is registered for the client (i.e. after a successful consent preview).
 */
export function buildDenyRedirect(redirectUri: string, state: string | null): string {
  const query: Record<string, string> = { error: "access_denied" }
  if (state !== null) query.state = state
  return appendQuery(redirectUri, query)
}

/** Short, recognisable label for where the client will receive the code. */
export function redirectHostLabel(redirectUri: string): string {
  try {
    const url = new URL(redirectUri)
    if (url.protocol === "http:" || url.protocol === "https:") return url.host
    // Custom schemes (`cursor://…`, `vscode://…`): show scheme plus host or path.
    const rest = url.host || url.pathname.replace(/^\/+/, "").split("/")[0] || ""
    return rest ? `${url.protocol}//${rest}` : url.protocol
  } catch {
    return redirectUri
  }
}

/**
 * Scopes offered on the consent screen: the ones the client asked for, or every scope when it asked
 * for none it knows about (the server then falls back to its defaults). The user can narrow the
 * request but is never offered more than the client requested.
 */
export function visibleScopes(
  scopes: McpConsentScopeView[],
  requested: readonly string[]
): McpConsentScopeView[] {
  const known = scopes.filter((s) => requested.includes(s.scope))
  return known.length > 0 ? known : scopes
}

/** Initial switch state: whatever the server marks `default_checked` (never `approvals:answer`). */
export function defaultSelectedScopes(scopes: McpConsentScopeView[]): McpScope[] {
  return scopes.filter((s) => s.default_checked && !s.high_risk).map((s) => s.scope)
}

export function canApprove(selection: { scopes: readonly string[]; deviceIds: readonly string[] }): boolean {
  // An empty device list would grant every normal device (including future ones), so the consent
  // page always requires an explicit choice.
  return selection.scopes.length > 0 && selection.deviceIds.length > 0
}
