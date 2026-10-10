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
  return {
    connectorId: runtime.connectorId,
    runtimeType: runtime.runtimeType,
    implementationType: runtime.runtimeType,
    displayName: runtimeTypeName(runtime),
    description: null,
    present: runtime.present,
    // A type synthesised from a known instance is a supported type: type-level
    // availability never derives from instance state.
    available: true,
    reason: null,
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
  _runtimes: readonly DeviceRuntimeView[],
): boolean {
  // Provider limits apply when starting a runtime, not when saving its config.
  return runtimeType.present && runtimeType.schema !== null
}

export function configuredRuntimeInstances(
  runtimes: readonly DeviceRuntimeView[],
): DeviceRuntimeView[] {
  return runtimes
    .filter((runtime) => runtime.configured)
    .sort((left, right) => runtimeInstanceName(left).localeCompare(runtimeInstanceName(right)))
}

export function runtimeInstancesAfterDeletion(
  runtimes: readonly DeviceRuntimeView[],
  deletedId: string,
  successor: DeviceRuntimeView,
): DeviceRuntimeView[] {
  return [
    ...runtimes.filter((runtime) => runtime.runtimeId !== deletedId && runtime.runtimeId !== successor.runtimeId),
    successor,
  ]
}

export function addableRuntimeTypes(
  runtimeTypes: readonly RuntimeTypeView[],
  runtimes: readonly DeviceRuntimeView[],
): RuntimeTypeView[] {
  return runtimeTypes.filter((runtimeType) => runtimeTypeCanCreateInstance(runtimeType, runtimes))
}

/**
 * Runtime types offered by quick setup (onboarding and the post-pairing dialog).
 * Those surfaces list configured instances alongside addable types, and their
 * quick add reuses an existing configured instance instead of creating another.
 * A type that already has a configured instance is therefore shown only once, as
 * that instance. Additional named instances are created from the device page.
 */
export function setupAddableRuntimeTypes(
  runtimeTypes: readonly RuntimeTypeView[],
  runtimes: readonly DeviceRuntimeView[],
): RuntimeTypeView[] {
  const configuredTypes = new Set(configuredRuntimeInstances(runtimes).map((runtime) => runtime.runtimeType))
  return addableRuntimeTypes(runtimeTypes, runtimes)
    .filter((runtimeType) => !configuredTypes.has(runtimeType.runtimeType))
}

export function reconfigurableRuntimeInstance(
  runtimeType: Pick<RuntimeTypeView, "runtimeType">,
  runtimes: readonly DeviceRuntimeView[],
): DeviceRuntimeView | null {
  return runtimes.find((runtime) => (
    runtime.runtimeType === runtimeType.runtimeType && !runtime.configured
  )) ?? null
}

export function suggestedRuntimeInstanceName(
  runtimeType: RuntimeTypeView,
  runtimes: readonly DeviceRuntimeView[],
): string {
  const defaultName = runtimeType.runtimeType === "dsh" ? "DSH" : runtimeType.displayName
  const names = new Set(runtimes.map((runtime) => runtimeInstanceName(runtime).toLocaleLowerCase()))
  if (!names.has(defaultName.toLocaleLowerCase())) return defaultName
  let suffix = 2
  while (names.has(`${defaultName} ${suffix}`.toLocaleLowerCase())) suffix += 1
  return `${defaultName} ${suffix}`
}

export function runtimeCreationDefaults(
  runtimeType: RuntimeTypeView,
): Record<string, unknown> {
  return { ...runtimeType.defaults }
}

export function runtimeConfigDraft(
  runtimeType: RuntimeTypeView,
  runtime: DeviceRuntimeView,
): Record<string, unknown> {
  if (runtime.config !== null) return { ...runtime.config }
  if (runtime.runtimeId === runtime.runtimeType) return { ...runtimeType.defaults }
  return runtimeCreationDefaults(runtimeType)
}

export function namedInstanceRequiredConfigFields(
  runtime: Pick<RuntimeTypeView, "schema" | "uiSchema">
    | Pick<DeviceRuntimeView, "schema" | "uiSchema">,
): string[] {
  const properties = isRecord(runtime.schema?.properties)
    ? runtime.schema.properties
    : {}
  const configuredFields = Array.isArray(runtime.uiSchema.requiredForNamedInstance)
    ? runtime.uiSchema.requiredForNamedInstance
    : []
  return [...new Set(configuredFields.filter((field): field is string => (
    typeof field === "string" && field.length > 0 && field in properties
  )))]
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
