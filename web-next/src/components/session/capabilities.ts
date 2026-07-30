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

export function findCapability(
  capabilitySet: ProtocolCapabilitySet | null | undefined,
  capabilityId: string,
): ProtocolCapability | null {
  return capabilitySet?.capabilities.find((capability) => capability.capabilityId === capabilityId) ?? null
}

export function capabilityIsUsable(
  capabilitySet: ProtocolCapabilitySet | null | undefined,
  capabilityId: string,
): boolean {
  const capability = findCapability(capabilitySet, capabilityId)
  return Boolean(capability?.supported && capability.available && capability.allowed)
}
