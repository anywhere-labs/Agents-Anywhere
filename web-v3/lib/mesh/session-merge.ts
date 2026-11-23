// Cross-client multi-device session merger strictly implementing all 5 rules in
// contracts/aa-v3/1.0/README.md and verified against contracts/aa-v3/1.0/fixtures/session-merge.json.

import type {
  DeviceResultStatus,
  DeviceSessionResult,
  SessionListPayload,
  SessionSummary,
} from "@/lib/types/v3"

export type MergeEventSource = "control_plane" | "client_tunnel"

export interface DeviceMergeState {
  status: DeviceResultStatus
  stale: boolean
  error_code?: string
  error_message?: string
  projects: string[]
  sessions: SessionSummary[]
}

export interface SessionMergeState {
  byDevice: Record<string, DeviceMergeState>
}

export function createSessionMergeState(
  initialCache: Record<string, SessionListPayload> = {}
): SessionMergeState {
  const byDevice: Record<string, DeviceMergeState> = {}
  for (const [deviceId, payload] of Object.entries(initialCache)) {
    byDevice[deviceId] = {
      status: "offline",
      stale: true,
      projects: [...payload.projects],
      sessions: [...payload.sessions],
    }
  }
  return { byDevice }
}

/**
 * Apply one control-plane fanout result or encrypted-device client-tunnel result.
 * Pure & immutable: returns a new state snapshot.
 */
export function applySessionMergeEvent(
  state: SessionMergeState,
  event: { source: MergeEventSource; result: DeviceSessionResult },
  localE2eeDevices: ReadonlySet<string>
): SessionMergeState {
  const { source, result } = event
  const deviceId = result.device_id
  const prev = state.byDevice[deviceId]
  const isLocallyLocked = localE2eeDevices.has(deviceId)

  // Rule 4: Locally pinned E2EE device NEVER accepts plaintext control-plane results!
  if (source === "control_plane" && isLocallyLocked && result.status === "ok") {
    return {
      byDevice: {
        ...state.byDevice,
        [deviceId]: {
          status: "error",
          stale: true,
          error_code: "e2e_required_locally",
          error_message: "This device is locally locked to end-to-end encryption.",
          projects: prev ? [...prev.projects] : [],
          sessions: prev ? [...prev.sessions] : [],
        },
      },
    }
  }

  // Rule 2: Control-plane `status: "encrypted"` marker must NEVER wipe client-side tunnel state or cache.
  if (source === "control_plane" && result.status === "encrypted") {
    if (prev) return state
    return {
      byDevice: {
        ...state.byDevice,
        [deviceId]: {
          status: "encrypted",
          stale: true,
          projects: [],
          sessions: [],
        },
      },
    }
  }

  // Rule 1: `status: "ok"` replaces the entire device slice (sessions + projects).
  if (result.status === "ok" && result.value) {
    return {
      byDevice: {
        ...state.byDevice,
        [deviceId]: {
          status: "ok",
          stale: false,
          projects: [...result.value.projects],
          sessions: [...result.value.sessions],
        },
      },
    }
  }

  // Rule 3: Non-ok (`offline`, `timeout`, `error`, or client-side `encrypted`) preserves cached sessions as stale.
  return {
    byDevice: {
      ...state.byDevice,
      [deviceId]: {
        status: result.status,
        stale: true,
        ...(result.error?.code ? { error_code: result.error.code } : {}),
        ...(result.error?.message ? { error_message: result.error.message } : {}),
        projects: prev ? [...prev.projects] : [],
        sessions: prev ? [...prev.sessions] : [],
      },
    },
  }
}

function compareAscii(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Rule 5 global sort:
 *   1. pinned === true before pinned === false
 *   2. updated_at descending (RFC 3339 instant)
 *   3. device_id ascending (ASCII)
 *   4. id ascending (ASCII)
 */
export function getMergedSessions(state: SessionMergeState): SessionSummary[] {
  const all: SessionSummary[] = []
  for (const slice of Object.values(state.byDevice)) {
    all.push(...slice.sessions)
  }
  return all.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const ta = Date.parse(a.updated_at)
    const tb = Date.parse(b.updated_at)
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
      return tb - ta
    }
    const isoCmp = compareAscii(b.updated_at, a.updated_at)
    if (isoCmp !== 0) return isoCmp
    const devCmp = compareAscii(a.device_id, b.device_id)
    if (devCmp !== 0) return devCmp
    return compareAscii(a.id, b.id)
  })
}

export function getMergedProjects(
  state: SessionMergeState
): { device_id: string; cwd: string; name: string }[] {
  const out: { device_id: string; cwd: string; name: string }[] = []
  const seen = new Set<string>()
  for (const [deviceId, slice] of Object.entries(state.byDevice)) {
    for (const cwd of slice.projects) {
      const key = `${deviceId}::${cwd}`
      if (seen.has(key)) continue
      seen.add(key)
      const name = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd
      out.push({ device_id: deviceId, cwd, name })
    }
  }
  return out.sort((a, b) => compareAscii(a.name, b.name) || compareAscii(a.device_id, b.device_id))
}
