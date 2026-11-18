// Agent collaboration API.
//
// Session routes (`/sessions/{id}/collab...`) go through the shared API client, so they reach the supervisor's device
// over HTTPS in normal mode and through its secure channel in encrypted mode. Settings are owned by the Server. The
// agent trust routes (`/e2ee/v1/...`) exist only inside a device's secure channel.

import { apiClient } from "@/lib/api"
import { ApiError, apiErrorKind } from "@/lib/api/errors"
import { e2eeRuntime } from "@/features/e2ee/runtime"
import type { AgentIdentityResponse } from "@/generated/e2ee/v1_0/agent-identity-response"
import type { ClientGrantView } from "@/generated/e2ee/v1_0/client-grant-view"
import type { PeerListResponse } from "@/generated/e2ee/v1_0/peer-list-response"
import {
  parseCollabSettings,
  parseCollabView,
  parseSupervisionDetail,
  type CollabAuthority,
  type CollabSettings,
  type CollabView,
  type SupervisionDetail,
  type SupervisionState,
  type SupervisionTrigger,
} from "@/features/collab/model"

export type CreateSupervisionInput = {
  targetSessionId: string
  targetDeviceId?: string | null
  triggers?: SupervisionTrigger[]
  authority?: Partial<CollabAuthority>
}

export type UpdateSupervisionInput = {
  state?: SupervisionState
  triggers?: SupervisionTrigger[]
  authority?: Partial<CollabAuthority>
}

function collabPath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/collab`
}

function supervisionOf(response: unknown): SupervisionDetail {
  const detail = parseSupervisionDetail((response as { supervision?: unknown } | null)?.supervision)
  if (!detail) throw new ApiError({ status: 502, kind: "http", code: "invalid_response", detail: "The device did not return the supervision." })
  return detail
}

export const collabApi = {
  async getSessionCollab(token: string, sessionId: string): Promise<CollabView> {
    return parseCollabView(await apiClient.get<unknown>(collabPath(sessionId), { token }), sessionId)
  },

  async createSupervision(token: string, supervisorSessionId: string, input: CreateSupervisionInput): Promise<SupervisionDetail> {
    const body: Record<string, unknown> = { operationId: crypto.randomUUID(), targetSessionId: input.targetSessionId }
    if (input.targetDeviceId) body.targetDeviceId = input.targetDeviceId
    if (input.triggers) body.triggers = input.triggers
    if (input.authority) body.authority = input.authority
    return supervisionOf(await apiClient.post<unknown>(`${collabPath(supervisorSessionId)}/supervisions`, body, { token }))
  },

  async updateSupervision(token: string, supervisorSessionId: string, supervisionId: string, input: UpdateSupervisionInput): Promise<SupervisionDetail> {
    const body: Record<string, unknown> = { operationId: crypto.randomUUID() }
    if (input.state) body.state = input.state
    if (input.triggers) body.triggers = input.triggers
    if (input.authority) body.authority = input.authority
    return supervisionOf(await apiClient.patch<unknown>(
      `${collabPath(supervisorSessionId)}/supervisions/${encodeURIComponent(supervisionId)}`,
      body,
      { token },
    ))
  },

  async getSettings(token: string): Promise<CollabSettings> {
    return parseCollabSettings(await apiClient.get<unknown>("/agent-collaboration/settings", { token }))
  },

  async putSettings(token: string, settings: CollabSettings): Promise<CollabSettings> {
    return parseCollabSettings(await apiClient.put<unknown>("/agent-collaboration/settings", settings, { token }))
  },
}

// ─── Encrypted mode: let one device's Agent reach another device ─────────────

async function channelCall<T>(deviceId: string, method: "GET" | "POST", path: string, body: unknown = null): Promise<T> {
  const runtime = e2eeRuntime()
  if (!runtime) throw new ApiError({ status: 409, kind: "http", code: "e2ee_unavailable", detail: "End-to-end encryption is not available in this client." })
  const channel = await runtime.pool.channel(deviceId)
  const response = await channel.request(method, path, body)
  if (response.status >= 400) {
    const detail = (response.body as { detail?: unknown } | null)?.detail
    const code = detail && typeof detail === "object" && "code" in detail ? String((detail as { code: unknown }).code) : undefined
    const message = typeof detail === "string" ? detail : `HTTP ${response.status}`
    throw new ApiError({ status: response.status, kind: apiErrorKind(response.status), code, detail: message, payload: response.body })
  }
  return response.body as T
}

export type AgentAccessInput = {
  /** The device whose Agent gets access (it serves `agent-identity` and keeps the peer pins). */
  sourceDeviceId: string
  /** The device the Agent may then open a channel to. */
  targetDeviceId: string
  targetLabel: string
}

export type AgentAccessStep = "identity" | "approve" | "pin"

/** What the agent access flow needs from the trust layer; the default uses this client's channels and pins. */
export type AgentTrustDeps = {
  /** The public key this client pinned for `deviceId`, or `null` when it is not paired. */
  pinnedDevicePub(deviceId: string): Promise<string | null>
  call<T>(deviceId: string, method: "GET" | "POST", path: string, body?: unknown): Promise<T>
}

const channelDeps: AgentTrustDeps = {
  async pinnedDevicePub(deviceId) {
    return (await e2eeRuntime()?.store.pin(deviceId))?.devicePub ?? null
  },
  call: channelCall,
}

/**
 * Reads the source device's Agent identity, asks the target device to trust it (the target confirms locally), then
 * hands the target's pinned key to the source device. `onStep` reports progress for the UI.
 */
export async function allowAgentAccess(
  deps: AgentTrustDeps,
  input: AgentAccessInput,
  agentLabel: string,
  onStep?: (step: AgentAccessStep) => void,
): Promise<PeerListResponse> {
  const targetPub = await deps.pinnedDevicePub(input.targetDeviceId)
  if (!targetPub) throw new ApiError({ status: 409, kind: "http", code: "e2ee_not_paired", detail: `Pair this client with device ${input.targetDeviceId} first.` })
  onStep?.("identity")
  const identity = await deps.call<AgentIdentityResponse>(input.sourceDeviceId, "GET", "/e2ee/v1/agent-identity")
  onStep?.("approve")
  await deps.call<ClientGrantView>(input.targetDeviceId, "POST", "/e2ee/v1/trust/approve", {
    clientIdentityPub: identity.identityPub,
    label: agentLabel,
    platform: "agent",
  })
  onStep?.("pin")
  return deps.call<PeerListResponse>(input.sourceDeviceId, "POST", "/e2ee/v1/peers/pin", {
    deviceId: input.targetDeviceId,
    deviceIdentityPub: targetPub,
    label: input.targetLabel,
  })
}

export const agentTrustApi = {
  peers(deviceId: string): Promise<PeerListResponse> {
    return channelCall<PeerListResponse>(deviceId, "GET", "/e2ee/v1/peers")
  },

  allowAgentAccess(input: AgentAccessInput, agentLabel: string, onStep?: (step: AgentAccessStep) => void): Promise<PeerListResponse> {
    return allowAgentAccess(channelDeps, input, agentLabel, onStep)
  },
}
