// Tokens Anywhere OAuth 2.0 PKCE S256 client + single-account managed Key reuse.
// Matches `anywhere-tokenhub/docs/oauth-web-apps.md` and `server-v3 /assistant/tokens`.

import {
  deleteAssistantTokens,
  fetchAssistantTokens,
  putAssistantTokens,
} from "@/lib/api/control-http"
import type { AssistantModelPref } from "@/lib/storage/idb"

export type ModelFormat = AssistantModelPref["format"]

export interface TokensModelItem {
  id: string
  ownedBy: string
  format: ModelFormat
  baseUrl: string
  name: string
}

const PENDING_TOKENS_KEY = "aa.v3.tokens.pending"

interface PendingTokensFlow {
  tokensUrl: string
  clientId: string
  verifier: string
  state: string
  redirectUri: string
  returnTo: string
}

function randomBase64Url(numBytes = 32): string {
  const bytes = new Uint8Array(numBytes)
  crypto.getRandomValues(bytes)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function sha256Base64Url(input: string): Promise<string> {
  if (!crypto.subtle) {
    throw new Error("PKCE requires HTTPS or localhost")
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
  let binary = ""
  const bytes = new Uint8Array(digest)
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function tokensCallbackUri(): string {
  return `${window.location.origin}/oauth/tokens/callback`
}

export async function startTokensConnect(options: {
  tokensUrl: string
  clientId: string
  returnTo?: string
}): Promise<string> {
  const tokensUrl = options.tokensUrl.replace(/\/+$/, "")
  const verifier = randomBase64Url(32)
  const state = randomBase64Url(24)
  const challenge = await sha256Base64Url(verifier)
  const redirectUri = tokensCallbackUri()

  const pending: PendingTokensFlow = {
    tokensUrl,
    clientId: options.clientId,
    verifier,
    state,
    redirectUri,
    returnTo: options.returnTo ?? "/assistant",
  }
  sessionStorage.setItem(PENDING_TOKENS_KEY, JSON.stringify(pending))

  const q = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: redirectUri,
    scope: "user",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  return `${tokensUrl}/oauth/authorize/?${q.toString()}`
}

async function revokeAtTokens(tokensUrl: string, clientId: string, token: string): Promise<void> {
  try {
    await fetch(`${tokensUrl}/api/v1/oauth/revoke`, {
      method: "POST",
      body: new URLSearchParams({ token, client_id: clientId }),
    })
  } catch {
    // RFC 7009 best-effort revocation
  }
}

/**
 * Exchange Tokens authorization code -> request managed key -> store in `server-v3 /assistant/tokens`.
 * If another browser connected first (`kept: true`), automatically revokes the redundant grant!
 */
export async function completeTokensCallback(params: {
  code: string
  state: string
  iss?: string | null
  serverUrl: string
  userAccessToken: string
}): Promise<{ key: string; tokensUrl: string; kept: boolean; returnTo: string }> {
  const raw = sessionStorage.getItem(PENDING_TOKENS_KEY)
  sessionStorage.removeItem(PENDING_TOKENS_KEY)
  if (!raw) throw new Error("Missing Tokens authorization state; please reconnect")

  const pending = JSON.parse(raw) as PendingTokensFlow
  if (pending.state !== params.state) {
    throw new Error("Tokens OAuth state mismatch")
  }
  if (params.iss && params.iss.replace(/\/+$/, "") !== pending.tokensUrl) {
    throw new Error("Tokens OAuth issuer mismatch")
  }

  const tokRes = await fetch(`${pending.tokensUrl}/api/v1/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: pending.clientId,
      code: params.code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
    }),
  })
  const tokData = (await tokRes.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    error?: string
    error_description?: string
  }
  if (!tokRes.ok || !tokData.access_token) {
    throw new Error(
      tokData.error_description ?? tokData.error ?? `Tokens exchange failed (${tokRes.status})`
    )
  }

  const keyRes = await fetch(`${pending.tokensUrl}/api/v1/keys/managed`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokData.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ app: pending.clientId }),
  })
  const keyData = (await keyRes.json().catch(() => ({}))) as { secret?: string }
  if (keyRes.status === 409) {
    throw new Error("Tokens managed key limit (50) reached; remove unused keys in Tokens")
  }
  if (!keyRes.ok || !keyData.secret) {
    throw new Error(`Failed to fetch managed key from Tokens (${keyRes.status})`)
  }

  const saved = await putAssistantTokens(params.serverUrl, params.userAccessToken, {
    key: keyData.secret,
    refresh: tokData.refresh_token ?? null,
  })
  if (saved.kept && tokData.refresh_token) {
    // Another browser connected first; revoke the duplicate grant we just created.
    await revokeAtTokens(pending.tokensUrl, pending.clientId, tokData.refresh_token)
  }
  return {
    key: saved.key ?? keyData.secret,
    tokensUrl: pending.tokensUrl,
    kept: Boolean(saved.kept),
    returnTo: pending.returnTo,
  }
}

export async function loadAccountTokens(serverUrl: string, userToken: string) {
  return fetchAssistantTokens(serverUrl, userToken)
}

export async function disconnectAccountTokens(
  serverUrl: string,
  userToken: string,
  staleKey?: string
) {
  let keyHash: string | undefined
  if (staleKey) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(staleKey))
    keyHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
  }
  return deleteAssistantTokens(serverUrl, userToken, keyHash)
}

const NOT_CHAT_RE =
  /embed|rerank|tts|whisper|transcribe|dall-e|image|audio|realtime|moderation|auto-review|computer-use/i

const PRETTY_WORDS: Record<string, string> = {
  deepseek: "DeepSeek",
  gemini: "Gemini",
  claude: "Claude",
  gpt: "GPT",
  qwen: "Qwen",
  glm: "GLM",
  kimi: "Kimi",
  grok: "Grok",
  llama: "Llama",
  minimax: "MiniMax",
  o1: "o1",
  o3: "o3",
  o4: "o4",
}

export function prettyModelName(id: string): string {
  const parts = id
    .replace(/^models\//, "")
    .replace(/^[a-z-]+\//, "")
    .split(/[-_]/)
    .filter(Boolean)
  const out: string[] = []
  for (const p of parts) {
    const known = PRETTY_WORDS[p.toLowerCase()]
    if (known) out.push(known)
    else if (/^v\d/i.test(p)) out.push(p.toUpperCase())
    else if (/^\d/.test(p) && out.at(-1) === "GPT") out[out.length - 1] = `GPT-${p}`
    else if (/^\d+$/.test(p) && /^\d+$/.test(out.at(-1) ?? "")) out[out.length - 1] += `.${p}`
    else if (/^\d/.test(p)) out.push(p)
    else out.push(p[0].toUpperCase() + p.slice(1))
  }
  return out.join(" ") || id
}

interface RawTokensModel {
  id: string
  owned_by?: string
  endpoints?: { type: string; protocol: string; base_url: string }[]
}

function pickTokensModel(m: RawTokensModel): TokensModelItem | null {
  if (NOT_CHAT_RE.test(m.id)) return null
  const eps = m.endpoints ?? []
  const find = (type: string) => eps.find((e) => e.type === type)
  const owner = (m.owned_by ?? "").toLowerCase()
  const id = m.id.toLowerCase()
  const order: [string, ModelFormat][] =
    owner === "anthropic" || owner === "deepseek" || /^(claude|deepseek)/.test(id)
      ? [
          ["messages", "anthropic-messages"],
          ["chat_completions", "openai-completions"],
          ["responses", "openai-responses"],
        ]
      : owner === "openai" || /^(gpt|o\d|codex|chatgpt)/.test(id)
        ? [
            ["responses", "openai-responses"],
            ["chat_completions", "openai-completions"],
            ["messages", "anthropic-messages"],
          ]
        : [
            ["chat_completions", "openai-completions"],
            ["messages", "anthropic-messages"],
            ["responses", "openai-responses"],
          ]
  for (const [type, format] of order) {
    const ep = find(type)
    if (ep) {
      return {
        id: m.id,
        ownedBy: m.owned_by ?? "",
        format,
        baseUrl: ep.base_url,
        name: prettyModelName(m.id),
      }
    }
  }
  return null
}

export async function fetchTokensModels(
  tokensUrl: string,
  apiKey: string
): Promise<TokensModelItem[]> {
  const base = tokensUrl.replace(/\/+$/, "")
  const res = await fetch(`${base}/v1/models?protocol=any`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (res.status === 401) {
    throw new Error("Tokens key is invalid or revoked (401); please reconnect")
  }
  const data = (await res.json().catch(() => ({}))) as { data?: RawTokensModel[] }
  if (!res.ok) throw new Error(`Failed to list Tokens models (${res.status})`)
  return (data.data ?? [])
    .map(pickTokensModel)
    .filter((item): item is TokensModelItem => item !== null)
}

export function pickDefaultTokensModel(models: TokensModelItem[]): TokensModelItem | undefined {
  const match = (re: RegExp) =>
    models
      .filter((m) => re.test(m.id))
      .sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }))[0]
  return match(/^claude-sonnet-\d/) ?? match(/^claude-/) ?? models[0]
}
