// Browser OAuth 2.1 / OIDC PKCE S256 client for consuming `anywhere-auth` or any standard OIDC IdP.
// AA v3 is strictly an OAuth/OIDC client — it does NOT provide IdP/OAuth provider services.

import { fetchMe, normalizeServerUrl } from "@/lib/api/control-http"
import type { StoredAccountSession } from "@/lib/storage/idb"
import type { OidcPublicConfig } from "@/lib/types/v3"

const PENDING_OIDC_KEY = "aa.v3.oidc.pending"

interface PendingOidcFlow {
  serverUrl: string
  issuer: string
  clientId: string
  tokenEndpoint: string
  redirectUri: string
  verifier: string
  state: string
  returnTo: string
}

function randomBase64Url(length = 32): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function pkceChallenge(verifier: string): Promise<string> {
  if (!crypto.subtle) {
    throw new Error("WebCrypto is unavailable on insecure origins; use HTTPS or localhost")
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  let binary = ""
  const bytes = new Uint8Array(digest)
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function oidcCallbackUri(): string {
  return `${window.location.origin}/auth/oidc/callback`
}

export async function startOidcLogin(options: {
  serverUrl: string
  oidc: OidcPublicConfig
  returnTo?: string
}): Promise<string> {
  const { oidc } = options
  if (!oidc.authorization_endpoint || !oidc.token_endpoint || !oidc.client_id) {
    throw new Error("OIDC provider configuration is incomplete on control plane")
  }
  const verifier = randomBase64Url(32)
  const state = randomBase64Url(24)
  const challenge = await pkceChallenge(verifier)
  const redirectUri = oidcCallbackUri()

  const pending: PendingOidcFlow = {
    serverUrl: normalizeServerUrl(options.serverUrl),
    issuer: oidc.issuer,
    clientId: oidc.client_id,
    tokenEndpoint: oidc.token_endpoint,
    redirectUri,
    verifier,
    state,
    returnTo: options.returnTo ?? "/",
  }
  sessionStorage.setItem(PENDING_OIDC_KEY, JSON.stringify(pending))

  const params = new URLSearchParams({
    response_type: "code",
    client_id: oidc.client_id,
    redirect_uri: redirectUri,
    scope: oidc.scopes || "openid profile email offline_access entitlements",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  const sep = oidc.authorization_endpoint.includes("?") ? "&" : "?"
  return `${oidc.authorization_endpoint}${sep}${params.toString()}`
}

export async function completeOidcCallback(params: {
  code: string
  state: string
}): Promise<{ session: StoredAccountSession; returnTo: string }> {
  const raw = sessionStorage.getItem(PENDING_OIDC_KEY)
  sessionStorage.removeItem(PENDING_OIDC_KEY)
  if (!raw) throw new Error("Missing OIDC login state; please start sign-in again")

  const pending = JSON.parse(raw) as PendingOidcFlow
  if (pending.state !== params.state) {
    throw new Error("OIDC state mismatch; possible CSRF or expired login attempt")
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: pending.clientId,
    code: params.code,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
  })
  const tokRes = await fetch(pending.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  })
  const tokJson = (await tokRes.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    id_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!tokRes.ok || !tokJson.access_token) {
    throw new Error(
      tokJson.error_description ?? tokJson.error ?? `OIDC token exchange failed (${tokRes.status})`
    )
  }

  const user = await fetchMe(pending.serverUrl, tokJson.access_token)
  const expiresIn = typeof tokJson.expires_in === "number" ? tokJson.expires_in : 3600
  const session: StoredAccountSession = {
    accountId: `${pending.serverUrl}::${user.id}`,
    serverUrl: pending.serverUrl,
    authMode: "oidc",
    accessToken: tokJson.access_token,
    refreshToken: tokJson.refresh_token ?? null,
    idToken: tokJson.id_token ?? null,
    tokenEndpoint: pending.tokenEndpoint,
    oidcClientId: pending.clientId,
    oidcIssuer: pending.issuer,
    expiresAt: Date.now() + expiresIn * 1000,
    user,
    lastUsedAt: Date.now(),
  }
  return { session, returnTo: pending.returnTo }
}

export async function refreshOidcSession(
  session: StoredAccountSession
): Promise<StoredAccountSession> {
  if (!session.refreshToken || !session.tokenEndpoint || !session.oidcClientId) {
    throw new Error("OIDC refresh token is unavailable; please sign in again")
  }
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: session.oidcClientId,
    refresh_token: session.refreshToken,
  })
  const res = await fetch(session.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  })
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    id_token?: string
    expires_in?: number
    error_description?: string
    error?: string
  }
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description ?? json.error ?? "OIDC token refresh failed")
  }
  const user = await fetchMe(session.serverUrl, json.access_token)
  return {
    ...session,
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? session.refreshToken,
    idToken: json.id_token ?? session.idToken,
    expiresAt: Date.now() + (typeof json.expires_in === "number" ? json.expires_in : 3600) * 1000,
    user,
    lastUsedAt: Date.now(),
  }
}
