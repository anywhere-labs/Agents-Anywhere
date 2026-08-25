import type {
  DeviceRuntimeView,
  RuntimeTypeView,
  SessionView,
} from "@/features/dashboard/types"

type SessionRuntimeIdentity = Pick<
  SessionView,
  "runtime" | "runtimeId" | "runtimeType" | "runtimeName" | "runtimeTypeDisplayName"
>

export function runtimeInstanceName(runtime: DeviceRuntimeView): string {
  return nonEmpty(runtime.name) ?? nonEmpty(runtime.displayName) ?? runtime.runtimeId
}

export function runtimeTypeName(runtime: DeviceRuntimeView): string {
  return nonEmpty(runtime.typeDisplayName)
    ?? (runtime.name ? nonEmpty(runtime.displayName) : null)
    ?? runtime.runtimeType
}

export function runtimeIsAvailable(runtime: DeviceRuntimeView): boolean {
  if (typeof runtime.available === "boolean") return runtime.available
  return runtime.present && runtime.discovery.available !== false
}

export function sessionRuntimeType(session: SessionRuntimeIdentity): string {
  return nonEmpty(session.runtimeType) ?? session.runtime
}

export function sessionRuntimeId(session: SessionRuntimeIdentity): string {
  return nonEmpty(session.runtimeId) ?? session.runtime
}

export function sessionRuntimeName(session: SessionRuntimeIdentity): string {
  const runtimeId = sessionRuntimeId(session)
  const runtimeType = sessionRuntimeType(session)
  return nonEmpty(session.runtimeName)
    ?? (runtimeId !== runtimeType ? runtimeId : null)
    ?? nonEmpty(session.runtimeTypeDisplayName)
    ?? runtimeType
}

export function sessionRuntimeRequestIdentity(
  runtimeType: string,
  runtimeId: string,
): { runtime: string; runtimeId?: string } {
  return runtimeId === runtimeType
    ? { runtime: runtimeType }
    : { runtime: runtimeType, runtimeId }
}

export function runtimeTypeFromLegacy(runtime: DeviceRuntimeView): RuntimeTypeView {
  const available = runtimeIsAvailable(runtime)
  return {
    connectorId: runtime.connectorId,
    runtimeType: runtime.runtimeType,
    implementationType: runtime.runtimeType,
    displayName: runtimeTypeName(runtime),
    description: null,
    present: runtime.present,
    available,
    reason: available ? null : "runtime_unavailable",
    recommended: false,
    recommendationRank: null,
    discovery: runtime.discovery,
    schema: runtime.schema,
    uiSchema: runtime.uiSchema,
    defaults: runtime.defaults ?? {},
    capabilities: runtime.capabilities ?? {},
    metadata: runtime.metadata,
    instancePolicy: "single",
    maxInstances: 1,
    lastDiscoveredAt: runtime.lastDiscoveredAt,
    createdAt: runtime.createdAt ?? runtime.updatedAt,
    updatedAt: runtime.updatedAt,
  }
}

export function mergeRuntimeTypes(
  runtimeTypes: readonly RuntimeTypeView[],
  runtimes: readonly DeviceRuntimeView[],
): RuntimeTypeView[] {
  const merged = new Map(runtimeTypes.map((runtimeType) => [runtimeType.runtimeType, runtimeType]))
  for (const runtime of runtimes) {
    if (!merged.has(runtime.runtimeType)) {
      merged.set(runtime.runtimeType, runtimeTypeFromLegacy(runtime))
    }
  }
  return [...merged.values()].sort(compareRuntimeTypes)
}

export function runtimeTypeCanCreateInstance(
  runtimeType: RuntimeTypeView,
  runtimes: readonly DeviceRuntimeView[],
): boolean {
  if (!runtimeType.present) return false
  const current = runtimes.filter((runtime) => runtime.runtimeType === runtimeType.runtimeType).length
  if (runtimeType.instancePolicy === "single" && current >= 1) return false
  return runtimeType.maxInstances === null || current < runtimeType.maxInstances
}

export function suggestedRuntimeInstanceName(
  runtimeType: RuntimeTypeView,
  runtimes: readonly DeviceRuntimeView[],
): string {
  const names = new Set(runtimes.map((runtime) => runtimeInstanceName(runtime).toLocaleLowerCase()))
  if (!names.has(runtimeType.displayName.toLocaleLowerCase())) return runtimeType.displayName
  let suffix = 2
  while (names.has(`${runtimeType.displayName} ${suffix}`.toLocaleLowerCase())) suffix += 1
  return `${runtimeType.displayName} ${suffix}`
}

function compareRuntimeTypes(left: RuntimeTypeView, right: RuntimeTypeView): number {
  if (left.recommended !== right.recommended) return left.recommended ? -1 : 1
  const leftRank = left.recommendationRank ?? Number.MAX_SAFE_INTEGER
  const rightRank = right.recommendationRank ?? Number.MAX_SAFE_INTEGER
  return leftRank - rightRank
    || left.displayName.localeCompare(right.displayName)
    || left.runtimeType.localeCompare(right.runtimeType)
}

function nonEmpty(value: string | null | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}
