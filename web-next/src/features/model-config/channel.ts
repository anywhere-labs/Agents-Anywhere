import type {
  ChannelRuntimeState,
  DeviceRuntimeView,
  ModelAssignment,
  ModelChannel,
  ModelChannelState,
} from "@/features/dashboard/types"

/** The device's own configuration: no model connection written by AA. */
export const NATIVE_CHANNEL = "native"
/** The linked Tokens Anywhere account. */
export const TOKENS_CHANNEL = "tokens"
/** Instances configuration management created; the channel lists the runtime they serve instead. */
export const MODEL_CONFIG_MANAGER = "model-config"

type Target = { connectorId: string; runtimeId: string }

const sameTarget = (a: Target, b: Target) => a.connectorId === b.connectorId && a.runtimeId === b.runtimeId

/** Still on its way: neither in effect, nor stopped by a failure, nor out of reach. */
export function switchUnfinished(row: ChannelRuntimeState): boolean {
  return row.state === "pending" || row.state === "waiting_online"
    || row.state === "switching" || row.state === "restoring"
}

export function switchFailed(row: ChannelRuntimeState): boolean {
  return row.state === "restored" || row.state === "failed"
}

export type ChannelProgress = {
  /** Runtimes taking part: every one that can use the channel it should. */
  total: number
  applied: number
  unfinished: number
  /** Devices that are offline with runtimes waiting on them. */
  offlineDevices: number
  restored: number
  failed: number
  unsupported: number
  phase: "none" | "running" | "done" | "attention"
}

/** Counts behind a channel's status line. */
export function channelProgress(channel: { runtimes: ChannelRuntimeState[] } | null | undefined): ChannelProgress {
  const rows = channel?.runtimes ?? []
  const taking = rows.filter((row) => row.state !== "unsupported")
  const count = (state: ChannelRuntimeState["state"]) => taking.filter((row) => row.state === state).length
  const progress = {
    total: taking.length,
    applied: count("applied"),
    unfinished: taking.filter(switchUnfinished).length,
    offlineDevices: new Set(taking.filter((row) => row.state === "waiting_online").map((row) => row.connectorId)).size,
    restored: count("restored"),
    failed: count("failed"),
    unsupported: rows.length - taking.length,
  }
  const phase: ChannelProgress["phase"] = progress.total === 0
    ? "none"
    : progress.restored + progress.failed > 0
      ? "attention"
      : progress.unfinished > 0 ? "running" : "done"
  return { ...progress, phase }
}

export type ChannelDevice<C> = {
  connectorId: string
  connector: C | null
  rows: ChannelRuntimeState[]
  unfinished: boolean
}

/**
 * Runtimes taking part, by device in the order devices are listed, and the
 * ones that cannot use the channel they should, kept apart.
 */
export function channelDevices<C extends { id: string }>(
  channel: { runtimes: ChannelRuntimeState[] } | null | undefined,
  connectors: C[],
): { devices: ChannelDevice<C>[]; unsupported: ChannelRuntimeState[] } {
  const rows = channel?.runtimes ?? []
  const byDevice = new Map<string, ChannelRuntimeState[]>()
  for (const row of rows) {
    if (row.state === "unsupported") continue
    const list = byDevice.get(row.connectorId) ?? []
    list.push(row)
    byDevice.set(row.connectorId, list)
  }
  const order = (id: string) => {
    const index = connectors.findIndex((connector) => connector.id === id)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }
  const devices = [...byDevice.entries()]
    .sort(([a], [b]) => order(a) - order(b))
    .map(([connectorId, list]) => ({
      connectorId,
      connector: connectors.find((connector) => connector.id === connectorId) ?? null,
      rows: list,
      unfinished: list.some((row) => row.state !== "applied"),
    }))
  return { devices, unsupported: rows.filter((row) => row.state === "unsupported") }
}

function isManagedInstance(runtime: DeviceRuntimeView, assignments: ModelAssignment[]): boolean {
  return runtime.managedBy === MODEL_CONFIG_MANAGER
    || assignments.some((item) => item.createdRuntime && sameTarget(item, runtime))
}

/**
 * The channel row for a runtime. A managed instance is not listed itself:
 * its row is the one of the runtime of the same type it serves on that device.
 */
export function channelRowFor(
  channel: ModelChannelState | null | undefined,
  runtimes: DeviceRuntimeView[],
  assignments: ModelAssignment[],
  target: Target,
): ChannelRuntimeState | null {
  if (!channel) return null
  const direct = channel.runtimes.find((row) => sameTarget(row, target))
  if (direct) return direct
  const runtime = runtimes.find((item) => sameTarget(item, target))
  if (!runtime || !isManagedInstance(runtime, assignments)) return null
  return channel.runtimes.find((row) => row.connectorId === target.connectorId && runtimes.some((item) =>
    sameTarget(item, row) && item.runtimeType === runtime.runtimeType && !isManagedInstance(item, assignments),
  )) ?? null
}

/** Changes whenever the channel a runtime actually uses changes, or settles. */
export function runtimeChannelKey(row: ChannelRuntimeState | null): string {
  return row ? `${row.actual}:${row.appliedGeneration ?? ""}:${row.state === "applied"}` : ""
}

/** Whether a runtime uses the Anywhere channel, verified. */
export function usesAnywhere(row: ChannelRuntimeState | null): boolean {
  return row?.actual === TOKENS_CHANNEL && row.state === "applied"
}

/** Runtimes that should use a channel: following it as the current one, or chosen for it. */
export function channelRows(channel: ModelChannelState | null | undefined, id: ModelChannel): ChannelRuntimeState[] {
  return (channel?.runtimes ?? []).filter((row) => row.desired === id)
}

/** Whether anything still wants or uses Anywhere; the Server refuses to unlink until nothing does. */
export function tokensWanted(channel: ModelChannelState | null | undefined): boolean {
  if (!channel) return false
  return channel.channel === TOKENS_CHANNEL
    || channel.runtimes.some((row) => row.desired === TOKENS_CHANNEL || row.actual === TOKENS_CHANNEL)
}

/** Runtimes actually using a channel right now. */
export function channelUsers(channel: ModelChannelState | null | undefined, id: ModelChannel): number {
  return (channel?.runtimes ?? []).filter((row) => row.actual === id).length
}

/** A profile cannot be deleted while it is current, chosen for a runtime, or in use. */
export function channelReferenced(channel: ModelChannelState | null | undefined, id: ModelChannel): boolean {
  if (!channel) return false
  return channel.channel === id
    || channel.runtimes.some((row) => row.override === id || row.desired === id || row.actual === id)
}
