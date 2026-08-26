import type { ProtocolCapability, ProtocolCapabilitySet } from "@/features/dashboard/types"

export const CAPABILITY = {
  sendMessage: "session.send_message",
  interrupt: "session.interrupt",
  steer: "session.steer",
  approveInteraction: "session.interaction.approval",
  attachment: "runtime.attachment",
  runtimeConfig: "runtime.config",
  modelCatalog: "catalog.model",
  permissionCatalog: "catalog.permission",
  effortCatalog: "catalog.effort",
} as const

export type KnownCapabilityId = (typeof CAPABILITY)[keyof typeof CAPABILITY]

export type RuntimeCapabilityScope = string | {
  runtimeId?: string | null
  runtimeType?: string | null
}

export function findCapability(
  capabilitySet: ProtocolCapabilitySet | null | undefined,
  capabilityId: string,
  runtime?: RuntimeCapabilityScope,
): ProtocolCapability | null {
  const matches = capabilitySet?.capabilities.filter(
    (capability) => capability.capabilityId === capabilityId,
  ) ?? []
  if (!runtime) return matches[0] ?? null
  const runtimeId = typeof runtime === "string" ? runtime : runtime.runtimeId ?? null
  const runtimeType = typeof runtime === "string" ? runtime : runtime.runtimeType ?? null
  return matches.find(
    (capability) => runtimeId && capability.runtimeId === runtimeId,
  )
    ?? matches.find((capability) => runtimeType && capability.runtime === runtimeType)
    ?? matches.find((capability) => !capability.runtime && !capability.runtimeId)
    ?? null
}

export function capabilityIsUsable(
  capabilitySet: ProtocolCapabilitySet | null | undefined,
  capabilityId: KnownCapabilityId,
  runtime?: RuntimeCapabilityScope,
): boolean {
  const capability = findCapability(capabilitySet, capabilityId, runtime)
  return Boolean(capability?.supported && capability.available && capability.allowed)
}
