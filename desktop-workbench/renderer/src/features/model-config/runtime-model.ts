import type {
  DeviceRuntimeView,
  ModelAssignment,
  ModelOffer,
  ModelProfile,
  ModelProtocol,
  ProtocolModelCatalog,
} from "@/features/dashboard/types"

/** What a runtime gives new sessions; existing sessions keep their own model. */
export type RuntimeModelSetting = { modelId: string; effortId?: string }

/** The runtime's own models, without a connection from Agents Anywhere. */
export const LOCAL_CHANNEL = "local"

export type ModelChannel = {
  /** A profile id, or `LOCAL_CHANNEL`. */
  id: string
  profileId: string | null
  name: string
  format: ModelProtocol | null
}

export type ChannelModel = { id: string; name: string }

/** The config field holding the runtime's model; absent when it takes none. */
export function runtimeModelField(runtime: DeviceRuntimeView): string | null {
  return runtime.modelConnection?.modelField || null
}

/** Runtimes the service-models page lists, by device in the given order. */
export function runtimesByDevice<T extends { id: string }>(
  connectors: T[],
  runtimes: DeviceRuntimeView[],
): { connector: T; runtimes: DeviceRuntimeView[] }[] {
  return connectors
    .map((connector) => ({
      connector,
      runtimes: runtimes.filter((runtime) => runtime.connectorId === connector.id && runtimeModelField(runtime)),
    }))
    .filter((group) => group.runtimes.length > 0)
}

/** The offer a runtime would take: the first protocol it speaks that the profile offers. */
export function matchOffer(protocols: ModelProtocol[], offers: ModelOffer[]): ModelOffer | null {
  for (const protocol of protocols) {
    const offer = offers.find((item) => item.format === protocol)
    if (offer) return offer
  }
  return null
}

/** The offer's models as runtimes get them: turned-off models left out, renamed ones renamed. */
export function offerModels(profile: Pick<ModelProfile, "preferences">, offer: ModelOffer): ChannelModel[] {
  const disabled = new Set(profile.preferences?.disabled ?? [])
  const names = profile.preferences?.names ?? {}
  return offer.models
    .filter((model) => !disabled.has(model.id))
    .map((model) => ({ id: model.id, name: names[model.id]?.trim() || model.name || model.id }))
}

/**
 * Whether the runtime's own models can be chosen. A runtime with run modes
 * (`modeField`) only takes a model through a connection — Pi keeps its own
 * models in its local mode, with no runtime-level catalog — so it has none.
 */
export function offersLocalChannel(runtime: DeviceRuntimeView): boolean {
  return Boolean(runtimeModelField(runtime)) && !runtime.modelConnection?.modeField
}

/** Channels for one runtime: each active profile offering a protocol it speaks, then its own models. */
export function channelsFor(runtime: DeviceRuntimeView, profiles: ModelProfile[], localName: string): ModelChannel[] {
  const protocols = runtime.modelConnection?.protocols ?? []
  const channels: ModelChannel[] = []
  for (const profile of profiles) {
    if (profile.state !== "active") continue
    const offer = matchOffer(protocols, profile.offers)
    if (!offer || offerModels(profile, offer).length === 0) continue
    channels.push({ id: profile.id, profileId: profile.id, name: profile.name, format: offer.format })
  }
  if (offersLocalChannel(runtime)) channels.push({ id: LOCAL_CHANNEL, profileId: null, name: localName, format: null })
  return channels
}

/** The runtime's own catalog models: what it offers without the models Agents Anywhere imported. */
export function localModels(catalog: ProtocolModelCatalog | null | undefined): ChannelModel[] {
  return (catalog?.models ?? [])
    .filter((model) => model.metadata?.source !== "runtime.config.customModels" && model.metadata?.enabled !== false)
    .map((model) => ({ id: model.id, name: model.displayName || model.id }))
}

/** Models offered on a channel; the local channel needs the runtime's catalog. */
export function channelModels(
  channel: ModelChannel | null,
  runtime: DeviceRuntimeView,
  profiles: ModelProfile[],
  catalog: ProtocolModelCatalog | null | undefined,
): ChannelModel[] {
  if (!channel) return []
  if (channel.profileId === null) return localModels(catalog)
  const profile = profiles.find((item) => item.id === channel.profileId)
  const offer = profile ? matchOffer(runtime.modelConnection?.protocols ?? [], profile.offers) : null
  return profile && offer ? offerModels(profile, offer) : []
}

/** The model the runtime's config sets, if any. */
export function currentRuntimeModel(runtime: DeviceRuntimeView): RuntimeModelSetting | null {
  const field = runtimeModelField(runtime)
  const value = field ? runtime.config?.[field] : null
  if (!value || typeof value !== "object") return null
  const { modelId, effortId } = value as Record<string, unknown>
  if (typeof modelId !== "string" || !modelId) return null
  return typeof effortId === "string" && effortId ? { modelId, effortId } : { modelId }
}

export const targetKey = (target: { connectorId: string; runtimeId: string }) => `${target.connectorId}/${target.runtimeId}`

/** The channel in use: the applied profile, else the runtime's own models when it has any. */
export function currentChannelId(runtime: DeviceRuntimeView, assignments: ModelAssignment[]): string | null {
  const assignment = assignments.find((item) => targetKey(item) === targetKey(runtime))
  if (assignment) return assignment.profileId
  return offersLocalChannel(runtime) ? LOCAL_CHANNEL : null
}

/** Only a running instance on an online device can change; the rest show what is saved. */
export function runtimeModelEditable(runtime: DeviceRuntimeView, deviceOnline: boolean): boolean {
  return deviceOnline && runtime.present && runtime.active && runtime.status === "running"
}

/** The config to save: everything as it is, with only the model changed. Keys stay saved on the Server. */
export function withRuntimeModel(
  runtime: DeviceRuntimeView,
  setting: RuntimeModelSetting | null,
): Record<string, unknown> {
  const field = runtimeModelField(runtime)
  const config: Record<string, unknown> = { ...(runtime.config ?? runtime.defaults ?? {}) }
  if (!field) return config
  if (setting) config[field] = setting.effortId ? { modelId: setting.modelId, effortId: setting.effortId } : { modelId: setting.modelId }
  else delete config[field]
  return config
}

export type RuntimeModelChange =
  /** Same channel: save the config with only the model changed; applies without a restart. */
  | { kind: "save"; config: Record<string, unknown> }
  /** Another profile: apply it to this runtime together with the model. */
  | { kind: "apply"; profileId: string; model: RuntimeModelSetting }
  /** From a profile to the runtime's own models: restore first, then save the model on the fresh config. */
  | { kind: "restore-then-save"; model: RuntimeModelSetting }

export function planRuntimeModelChange(
  runtime: DeviceRuntimeView,
  currentChannel: string | null,
  nextChannel: string,
  model: RuntimeModelSetting,
): RuntimeModelChange {
  if (nextChannel === currentChannel) return { kind: "save", config: withRuntimeModel(runtime, model) }
  if (nextChannel === LOCAL_CHANNEL) return { kind: "restore-then-save", model }
  return { kind: "apply", profileId: nextChannel, model }
}
