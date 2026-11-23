// Typed HTTP client for Agents Anywhere v3 control plane (`server-v3`).
// Supports simple password auth (local mode), OIDC client Bearer tokens (oidc mode),
// Cloud Drive presigned S3 transfers, Assistant sync/SSE/KEK-DEK/Tokens, and MCP grants.

import type {
  AdminDrivePolicyResponse,
  AssistantConversationDetail,
  AssistantConversationMeta,
  AssistantEncryptionStatusResponse,
  AssistantKeyEnvelopeView,
  AssistantTokensView,
  AuthConfigResponse,
  AuthTokenResponse,
  ClientRouterTokenResponse,
  DeviceMode,
  DevicePlatform,
  DriveEncryptionMode,
  DriveFileView,
  DrivePurpose,
  DriveQuotaView,
  ListAssistantConversationsResponse,
  McpAuthorizeApproveResponse,
  McpConsentPreview,
  McpGrantView,
  McpScope,
  PresignedHttpTarget,
  RegisterDeviceResponse,
  UserView,
} from "@/lib/types/v3"

export class ControlApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "ControlApiError"
    this.status = status
    this.code = code
  }
}

export function normalizeServerUrl(url?: string | null): string {
  const raw = (url ?? "").trim()
  if (raw) return raw.replace(/\/+$/, "")
  const envUrl = (process.env.NEXT_PUBLIC_AA_CONTROL_URL ?? "").trim()
  if (envUrl) return envUrl.replace(/\/+$/, "")
  return "/api/control"
}

async function requestJson<T>(
  serverUrl: string,
  path: string,
  init: RequestInit & { token?: string | null } = {}
): Promise<T> {
  const { token, headers, ...rest } = init
  const merged = new Headers(headers)
  if (!merged.has("Accept")) merged.set("Accept", "application/json")
  if (rest.body && typeof rest.body === "string" && !merged.has("Content-Type")) {
    merged.set("Content-Type", "application/json")
  }
  if (token) merged.set("Authorization", `Bearer ${token}`)

  const res = await fetch(`${normalizeServerUrl(serverUrl)}${path}`, {
    ...rest,
    headers: merged,
  })
  const text = await res.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }
  if (!res.ok) {
    const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
    const code = typeof obj?.code === "string" ? obj.code : `http_${res.status}`
    const detail =
      typeof obj?.detail === "string"
        ? obj.detail
        : typeof obj?.message === "string"
          ? obj.message
          : res.statusText || `HTTP ${res.status}`
    throw new ControlApiError(res.status, code, detail)
  }
  return parsed as T
}

// ---------------------------------------------------------------------------
// Auth & Control Bootstrap
// ---------------------------------------------------------------------------

export function fetchAuthConfig(serverUrl: string): Promise<AuthConfigResponse> {
  return requestJson<AuthConfigResponse>(serverUrl, "/auth/config")
}

export function loginWithPassword(
  serverUrl: string,
  payload: { email: string; password: string; client_id?: string }
): Promise<AuthTokenResponse> {
  return requestJson<AuthTokenResponse>(serverUrl, "/auth/login", {
    method: "POST",
    body: JSON.stringify({ ...payload, client_platform: "web" }),
  })
}

export function registerWithPassword(
  serverUrl: string,
  payload: {
    email: string
    password: string
    display_name: string
    setup_token?: string
    client_id?: string
  }
): Promise<AuthTokenResponse> {
  return requestJson<AuthTokenResponse>(serverUrl, "/auth/register", {
    method: "POST",
    body: JSON.stringify({ ...payload, client_platform: "web" }),
  })
}

export function refreshLocalSession(
  serverUrl: string,
  refreshToken: string
): Promise<AuthTokenResponse> {
  return requestJson<AuthTokenResponse>(serverUrl, "/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
}

export function logoutLocalSession(serverUrl: string, refreshToken: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(serverUrl, "/auth/logout", {
    method: "POST",
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
}

export function fetchMe(serverUrl: string, token: string): Promise<UserView> {
  return requestJson<UserView>(serverUrl, "/auth/me", { token })
}

export function issueClientRouterToken(
  serverUrl: string,
  token: string,
  clientId: string
): Promise<ClientRouterTokenResponse> {
  return requestJson<ClientRouterTokenResponse>(serverUrl, "/auth/router-token", {
    method: "POST",
    token,
    body: JSON.stringify({ client_id: clientId, platform: "web" }),
  })
}

export function registerDevice(
  serverUrl: string,
  token: string,
  payload: {
    name: string
    platform: DevicePlatform
    mode_hint?: DeviceMode
    connector_version?: string
  }
): Promise<RegisterDeviceResponse> {
  return requestJson<RegisterDeviceResponse>(serverUrl, "/devices/register", {
    method: "POST",
    token,
    body: JSON.stringify(payload),
  })
}

// ---------------------------------------------------------------------------
// Cloud Drive (/drive/* & /admin/drive/policies/*)
// ---------------------------------------------------------------------------

export function fetchDriveQuota(serverUrl: string, token: string): Promise<DriveQuotaView> {
  return requestJson<DriveQuotaView>(serverUrl, "/drive/quota", { token })
}

export function listDriveFiles(
  serverUrl: string,
  token: string,
  params?: { purpose?: DrivePurpose; vfs_prefix?: string; limit?: number; offset?: number }
): Promise<{ files: DriveFileView[]; quota: DriveQuotaView }> {
  const q = new URLSearchParams()
  if (params?.purpose) q.set("purpose", params.purpose)
  if (params?.vfs_prefix) q.set("vfs_prefix", params.vfs_prefix)
  if (params?.limit != null) q.set("limit", String(params.limit))
  if (params?.offset != null) q.set("offset", String(params.offset))
  const qs = q.toString() ? `?${q.toString()}` : ""
  return requestJson<{ files: DriveFileView[]; quota: DriveQuotaView }>(
    serverUrl,
    `/drive/files${qs}`,
    { token }
  )
}

export function createDriveUpload(
  serverUrl: string,
  token: string,
  payload: {
    purpose: DrivePurpose
    size_bytes: number
    sha256: string
    filename?: string | null
    mime_type?: string | null
    vfs_path?: string | null
    ttl_seconds?: number | null
    encryption_mode?: DriveEncryptionMode
    encryption_nonce?: string | null
    encryption_key_version?: number | null
    encrypted_meta?: string | null
  }
): Promise<{ file: DriveFileView; upload: PresignedHttpTarget }> {
  return requestJson<{ file: DriveFileView; upload: PresignedHttpTarget }>(
    serverUrl,
    "/drive/uploads",
    {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }
  )
}

export function completeDriveUpload(
  serverUrl: string,
  token: string,
  fileId: string,
  etag?: string | null
): Promise<DriveFileView> {
  return requestJson<DriveFileView>(serverUrl, `/drive/files/${encodeURIComponent(fileId)}/complete`, {
    method: "POST",
    token,
    body: JSON.stringify(etag ? { etag } : {}),
  })
}

export function fetchDriveDownloadUrl(
  serverUrl: string,
  token: string,
  fileId: string
): Promise<{ file: DriveFileView; download: PresignedHttpTarget }> {
  return requestJson<{ file: DriveFileView; download: PresignedHttpTarget }>(
    serverUrl,
    `/drive/files/${encodeURIComponent(fileId)}/download-url`,
    { token }
  )
}

export function deleteDriveFile(
  serverUrl: string,
  token: string,
  fileId: string
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(serverUrl, `/drive/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    token,
  })
}

export function fetchAdminDrivePolicy(
  serverUrl: string,
  token: string,
  targetUserId: string
): Promise<AdminDrivePolicyResponse> {
  return requestJson<AdminDrivePolicyResponse>(
    serverUrl,
    `/admin/drive/policies/${encodeURIComponent(targetUserId)}`,
    { token }
  )
}

export function updateAdminDrivePolicy(
  serverUrl: string,
  token: string,
  targetUserId: string,
  payload: {
    quota_bytes?: number | null
    max_file_bytes?: number | null
    default_ttl_seconds?: number | null
    max_ttl_seconds?: number | null
  }
): Promise<AdminDrivePolicyResponse> {
  return requestJson<AdminDrivePolicyResponse>(
    serverUrl,
    `/admin/drive/policies/${encodeURIComponent(targetUserId)}`,
    {
      method: "PUT",
      token,
      body: JSON.stringify(payload),
    }
  )
}

export function deleteAdminDrivePolicy(
  serverUrl: string,
  token: string,
  targetUserId: string
): Promise<AdminDrivePolicyResponse> {
  return requestJson<AdminDrivePolicyResponse>(
    serverUrl,
    `/admin/drive/policies/${encodeURIComponent(targetUserId)}`,
    {
      method: "DELETE",
      token,
    }
  )
}

// ---------------------------------------------------------------------------
// Portable Assistant (/assistant/*)
// ---------------------------------------------------------------------------

export function listAssistantConversations(
  serverUrl: string,
  token: string
): Promise<ListAssistantConversationsResponse> {
  return requestJson<ListAssistantConversationsResponse>(serverUrl, "/assistant/conversations", {
    token,
  })
}

export function getAssistantConversation(
  serverUrl: string,
  token: string,
  conversationId: string
): Promise<AssistantConversationDetail> {
  return requestJson<AssistantConversationDetail>(
    serverUrl,
    `/assistant/conversations/${encodeURIComponent(conversationId)}`,
    { token }
  )
}

export function putAssistantConversation(
  serverUrl: string,
  token: string,
  conversationId: string,
  body: Record<string, unknown>
): Promise<AssistantConversationMeta> {
  return requestJson<AssistantConversationMeta>(
    serverUrl,
    `/assistant/conversations/${encodeURIComponent(conversationId)}`,
    {
      method: "PUT",
      token,
      body: JSON.stringify(body),
    }
  )
}

export function deleteAssistantConversation(
  serverUrl: string,
  token: string,
  conversationId: string,
  device: string
): Promise<{ ok: boolean }> {
  const qs = device ? `?device=${encodeURIComponent(device)}` : ""
  return requestJson<{ ok: boolean }>(
    serverUrl,
    `/assistant/conversations/${encodeURIComponent(conversationId)}${qs}`,
    {
      method: "DELETE",
      token,
    }
  )
}

export function fetchAssistantEncryption(
  serverUrl: string,
  token: string
): Promise<AssistantEncryptionStatusResponse> {
  return requestJson<AssistantEncryptionStatusResponse>(serverUrl, "/assistant/encryption", {
    token,
  })
}

export function putAssistantKeyEnvelope(
  serverUrl: string,
  token: string,
  payload: {
    kdf: "pbkdf2-sha256" | "argon2id"
    kdf_params: Record<string, number | string>
    salt: string
    wrap_alg?: "AES-256-GCM"
    wrap_nonce?: string | null
    wrapped_dek: string
    expected_version?: number | null
    device?: string | null
  }
): Promise<AssistantEncryptionStatusResponse> {
  return requestJson<AssistantEncryptionStatusResponse>(serverUrl, "/assistant/encryption", {
    method: "PUT",
    token,
    body: JSON.stringify({ wrap_alg: "AES-256-GCM", ...payload }),
  })
}

export function resetAssistantEncryption(
  serverUrl: string,
  token: string,
  payload: {
    confirm_wipe: boolean
    new_envelope?: Omit<AssistantKeyEnvelopeView, "key_version" | "dek_epoch" | "created_at" | "updated_at"> | null
    wipe_drive_vfs?: boolean
    device?: string | null
  }
): Promise<{
  enabled: boolean
  envelope: AssistantKeyEnvelopeView | null
  wiped_conversations: number
  wiped_drive_files: number
}> {
  return requestJson(serverUrl, "/assistant/encryption/reset", {
    method: "POST",
    token,
    body: JSON.stringify(payload),
  })
}

export function deleteAssistantEncryption(
  serverUrl: string,
  token: string,
  confirmWipe: boolean
): Promise<{
  enabled: boolean
  envelope: AssistantKeyEnvelopeView | null
  wiped_conversations: number
  wiped_drive_files: number
}> {
  return requestJson(
    serverUrl,
    `/assistant/encryption?confirm_wipe=${confirmWipe ? "true" : "false"}`,
    {
      method: "DELETE",
      token,
    }
  )
}

export function fetchAssistantTokens(
  serverUrl: string,
  token: string
): Promise<AssistantTokensView> {
  return requestJson<AssistantTokensView>(serverUrl, "/assistant/tokens", { token })
}

export function putAssistantTokens(
  serverUrl: string,
  token: string,
  payload: { key: string; refresh?: string | null }
): Promise<AssistantTokensView> {
  return requestJson<AssistantTokensView>(serverUrl, "/assistant/tokens", {
    method: "PUT",
    token,
    body: JSON.stringify(payload),
  })
}

export function deleteAssistantTokens(
  serverUrl: string,
  token: string,
  keyHash?: string
): Promise<{ connected: boolean; removed: boolean }> {
  const qs = keyHash ? `?key_hash=${encodeURIComponent(keyHash)}` : ""
  return requestJson<{ connected: boolean; removed: boolean }>(
    serverUrl,
    `/assistant/tokens${qs}`,
    {
      method: "DELETE",
      token,
    }
  )
}

export interface AssistantSseMessage {
  event: string
  data: Record<string, unknown>
}

/**
 * Subscribe to `GET /assistant/events` SSE over fetch (carries Authorization Bearer header).
 */
export async function streamAssistantEvents(
  serverUrl: string,
  token: string,
  onEvent: (msg: AssistantSseMessage) => void,
  signal: AbortSignal
): Promise<void> {
  const res = await fetch(`${normalizeServerUrl(serverUrl)}/assistant/events`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "text/event-stream",
    },
    signal,
  })
  if (!res.ok || !res.body) {
    throw new ControlApiError(res.status, "sse_failed", `SSE stream failed (${res.status})`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let currentEvent = "message"
  let dataLines: string[] = []

  const flush = () => {
    if (!dataLines.length) {
      currentEvent = "message"
      return
    }
    const raw = dataLines.join("\n")
    const ev = currentEvent
    currentEvent = "message"
    dataLines = []
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object") {
        onEvent({ event: ev, data: parsed as Record<string, unknown> })
      }
    } catch {
      // ignore malformed frames
    }
  }

  while (!signal.aborted) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (line === "") {
        flush()
      } else if (line.startsWith(":")) {
        // comment / heartbeat
      } else if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim()
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim())
      }
    }
  }
}

// ---------------------------------------------------------------------------
// MCP Grants & One-click Built-in Assistant AA `/mcp` Mount
// ---------------------------------------------------------------------------

export async function listMcpGrants(serverUrl: string, token: string): Promise<McpGrantView[]> {
  const res = await requestJson<{ grants: McpGrantView[] }>(serverUrl, "/mcp/grants", { token })
  return res.grants
}

export function revokeMcpGrant(
  serverUrl: string,
  token: string,
  grantId: string
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(serverUrl, `/mcp/grants/${encodeURIComponent(grantId)}`, {
    method: "DELETE",
    token,
  })
}

/** Consent preview for an external MCP client's authorization request (`GET /oauth/authorize`). */
export function fetchMcpConsentPreview(
  serverUrl: string,
  token: string,
  params: { clientId: string; redirectUri: string; scopes: string[] }
): Promise<McpConsentPreview> {
  const query = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: params.scopes.join(" "),
  })
  return requestJson<McpConsentPreview>(serverUrl, `/oauth/authorize?${query.toString()}`, { token })
}

/** Approve an external MCP client's authorization request (`POST /oauth/authorize`). */
export function approveMcpAuthorization(
  serverUrl: string,
  token: string,
  params: {
    clientId: string
    redirectUri: string
    codeChallenge: string
    codeChallengeMethod: "S256"
    state: string | null
    scopes: McpScope[]
    deviceIds: string[]
  }
): Promise<McpAuthorizeApproveResponse> {
  return requestJson<McpAuthorizeApproveResponse>(serverUrl, "/oauth/authorize", {
    method: "POST",
    token,
    body: JSON.stringify({
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      code_challenge_method: params.codeChallengeMethod,
      state: params.state,
      scopes: params.scopes,
      device_ids: params.deviceIds,
    }),
  })
}

async function sha256Base64Url(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  let binary = ""
  const arr = new Uint8Array(digest)
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i])
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function randomBase64Url(numBytes = 32): string {
  const bytes = new Uint8Array(numBytes)
  crypto.getRandomValues(bytes)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * Provision a scoped MCP Bearer token (`aamcp_...`) for the built-in Portable Assistant
 * to mount AA's own `/mcp` endpoint (respecting normal-device + allow_mcp + explicit scopes).
 */
export async function provisionBuiltInAssistantMcpToken(
  serverUrl: string,
  userToken: string,
  options: { scopes: McpScope[]; deviceIds: string[]; clientName?: string }
): Promise<{ accessToken: string; mcpUrl: string; clientId: string }> {
  const base = normalizeServerUrl(serverUrl)
  const redirectUri = "https://agents-anywhere.local/assistant-mcp"
  const reg = await requestJson<{ client_id: string }>(base, "/oauth/register", {
    method: "POST",
    body: JSON.stringify({
      client_name: options.clientName ?? "AA Portable Assistant",
      redirect_uris: [redirectUri],
    }),
  })
  const verifier = randomBase64Url(32)
  const challenge = await sha256Base64Url(verifier)
  const approved = await requestJson<{ code: string }>(base, "/oauth/authorize", {
    method: "POST",
    token: userToken,
    body: JSON.stringify({
      client_id: reg.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scopes: options.scopes,
      device_ids: options.deviceIds,
    }),
  })
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: reg.client_id,
    code: approved.code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })
  const tokRes = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  })
  const tokJson = (await tokRes.json().catch(() => null)) as { access_token?: string; error?: string } | null
  if (!tokRes.ok || !tokJson?.access_token) {
    throw new ControlApiError(
      tokRes.status,
      tokJson?.error ?? "mcp_token_exchange_failed",
      "Failed to provision built-in AA MCP token"
    )
  }
  return {
    accessToken: tokJson.access_token,
    mcpUrl: `${base}/mcp`,
    clientId: reg.client_id,
  }
}
