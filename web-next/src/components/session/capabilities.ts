import type { ProtocolCapability, ProtocolCapabilitySet } from "@/features/dashboard/types"

export const CAPABILITY = {
  sendMessage: "session.send_message",
  interrupt: "session.interrupt",
  steer: "session.steer",
  approveInteraction: "session.interaction.approval",
  runtimeConfig: "runtime.config",
  modelCatalog: "catalog.model",
  permissionCatalog: "catalog.permission",
  effortCatalog: "catalog.effort",
} as const

export type KnownCapabilityId = (typeof CAPABILITY)[keyof typeof CAPABILITY]

export function findCapability(
  capabilitySet: ProtocolCapabilitySet | null | undefined,
  capabilityId: string,
  runtime?: string,
): ProtocolCapability | null {
  const matches = capabilitySet?.capabilities.filter(
    (capability) => capability.capabilityId === capabilityId,
  ) ?? []
  if (!runtime) return matches[0] ?? null
  return matches.find((capability) => capability.runtime === runtime)
    ?? matches.find((capability) => !capability.runtime)
    ?? null
}

export function capabilityIsUsable(
  capabilitySet: ProtocolCapabilitySet | null | undefined,
  capabilityId: KnownCapabilityId,
  runtime?: string,
): boolean {
  const capability = findCapability(capabilitySet, capabilityId, runtime)
  return Boolean(capability?.supported && capability.available && capability.allowed)
}
