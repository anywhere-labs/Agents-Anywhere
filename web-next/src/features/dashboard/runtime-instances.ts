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
  if (!runtimeType.present || runtimeType.schema === null) return false
  if (reconfigurableRuntimeInstance(runtimeType, runtimes)) return true
  const current = runtimes.filter((runtime) => runtime.runtimeType === runtimeType.runtimeType).length
  if (runtimeType.instancePolicy === "single" && current >= 1) return false
  return runtimeType.maxInstances === null || current < runtimeType.maxInstances
}

export function configuredRuntimeInstances(
  runtimes: readonly DeviceRuntimeView[],
): DeviceRuntimeView[] {
  return runtimes
    .filter((runtime) => runtime.configured)
    .sort((left, right) => runtimeInstanceName(left).localeCompare(runtimeInstanceName(right)))
}

export function addableRuntimeTypes(
  runtimeTypes: readonly RuntimeTypeView[],
  runtimes: readonly DeviceRuntimeView[],
): RuntimeTypeView[] {
  return runtimeTypes.filter((runtimeType) => runtimeTypeCanCreateInstance(runtimeType, runtimes))
}

export function isAdditionalCodexRuntimeType(
  runtimeType: RuntimeTypeView,
  runtimes: readonly DeviceRuntimeView[],
): boolean {
  return runtimeType.runtimeType === "codex"
    && runtimeType.instancePolicy === "multiple"
    && runtimes.some((runtime) => (
      runtime.runtimeType === "codex" && runtime.configured
    ))
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
  const names = new Set(runtimes.map((runtime) => runtimeInstanceName(runtime).toLocaleLowerCase()))
  if (!names.has(runtimeType.displayName.toLocaleLowerCase())) return runtimeType.displayName
  let suffix = 2
  while (names.has(`${runtimeType.displayName} ${suffix}`.toLocaleLowerCase())) suffix += 1
  return `${runtimeType.displayName} ${suffix}`
}

export function runtimeCreationDefaults(
  runtimeType: RuntimeTypeView,
  instanceName: string,
  randomId: string = globalThis.crypto.randomUUID(),
): Record<string, unknown> {
  const defaults = { ...runtimeType.defaults }
  if (runtimeType.runtimeType !== "codex") return defaults

  const suffix = randomId.replace(/[^a-zA-Z0-9]/g, "").toLocaleLowerCase().slice(0, 12)
  if (!suffix) throw new Error("A random identifier is required for the Codex Home")
  return {
    ...defaults,
    codexHome: `~/.agents-anywhere/codex-homes/${runtimeInstancePathSlug(instanceName)}-${suffix}`,
    modelGateway: { baseUrl: "", apiKey: "" },
  }
}

export function namedInstanceRequiredConfigFields(
  runtime: Pick<RuntimeTypeView, "runtimeType" | "schema" | "uiSchema">
    | Pick<DeviceRuntimeView, "runtimeType" | "schema" | "uiSchema">,
): string[] {
  const properties = isRecord(runtime.schema?.properties)
    ? runtime.schema.properties
    : {}
  const configuredFields = Array.isArray(runtime.uiSchema.requiredForNamedInstance)
    ? runtime.uiSchema.requiredForNamedInstance
    : []
  const fallbackFields = runtime.runtimeType === "codex"
    ? ["codexHome", "modelGateway"]
    : []
  return [...new Set([...configuredFields, ...fallbackFields].filter((field): field is string => (
    typeof field === "string" && field.length > 0 && field in properties
  )))]
}

function runtimeInstancePathSlug(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "codex"
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
