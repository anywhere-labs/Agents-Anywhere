export type RuntimeTypeDescriptorLike = {
  runtimeType: string
  displayName: string
  available: boolean
  recommended: boolean
  recommendationRank: number | null
}

export type RuntimeInstanceLike = {
  runtimeId: string
  runtimeType: string
  name: string
  typeDisplayName: string
}

export function availableRuntimeTypes<T extends RuntimeTypeDescriptorLike>(
  runtimeTypes: T[],
): T[] {
  return runtimeTypes
    .filter((runtimeType) => runtimeType.available)
    .sort(compareRuntimeTypes)
}

export function recommendedRuntimeTypes<T extends RuntimeTypeDescriptorLike>(
  runtimeTypes: T[],
): T[] {
  return availableRuntimeTypes(runtimeTypes).filter((runtimeType) => runtimeType.recommended)
}

export function runtimeInstanceOptions<T extends RuntimeInstanceLike>(runtimes: T[]) {
  return [...runtimes]
    .sort((left, right) => {
      const nameOrder = left.name.localeCompare(right.name)
      return nameOrder || left.runtimeId.localeCompare(right.runtimeId)
    })
    .map((runtime) => ({
      id: runtime.runtimeId,
      label: runtime.name,
      description: runtime.typeDisplayName,
    }))
}

export function nextRuntimeInstanceName(
  baseName: string,
  runtimes: RuntimeInstanceLike[],
): string {
  const normalizedBase = baseName.trim() || "Runtime"
  const names = new Set(runtimes.map((runtime) => runtime.name.trim().toLocaleLowerCase()))
  if (!names.has(normalizedBase.toLocaleLowerCase())) return normalizedBase
  let suffix = 2
  while (names.has(`${normalizedBase} ${suffix}`.toLocaleLowerCase())) suffix += 1
  return `${normalizedBase} ${suffix}`
}

export function findCreatedRuntime<T extends RuntimeInstanceLike>(
  beforeRuntimeIds: Set<string>,
  after: T[],
  runtimeType: string,
  name: string,
): T | null {
  const created = after.filter((runtime) => (
    !beforeRuntimeIds.has(runtime.runtimeId) && runtime.runtimeType === runtimeType
  ))
  const nameKey = normalizedRuntimeName(name)
  return created.find((runtime) => normalizedRuntimeName(runtime.name) === nameKey)
    ?? (created.length === 1 ? created[0]! : null)
}

export function runtimeErrorMessage(error: unknown): string | null {
  if (typeof error === "string") return nonEmptyString(error)
  if (!isRecord(error)) return null

  const directMessage = nonEmptyString(error.message)
  if (directMessage) return directMessage

  const nestedMessage = findNestedMessage(error, new Set([error]))
  if (nestedMessage) return nestedMessage

  const directCode = nonEmptyString(error.code)
  if (directCode) return directCode
  return findNestedCode(error, new Set([error]))
}

function compareRuntimeTypes(
  left: RuntimeTypeDescriptorLike,
  right: RuntimeTypeDescriptorLike,
): number {
  const leftRank = left.recommendationRank ?? Number.MAX_SAFE_INTEGER
  const rightRank = right.recommendationRank ?? Number.MAX_SAFE_INTEGER
  return leftRank - rightRank || left.displayName.localeCompare(right.displayName)
}

function normalizedRuntimeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase()
}

function findNestedMessage(value: Record<string, unknown>, visited: Set<object>): string | null {
  for (const key of ["detail", "error", "cause", "reason"]) {
    const nested = value[key]
    const direct = nonEmptyString(nested)
    if (direct) return direct
    if (!isRecord(nested) || visited.has(nested)) continue
    visited.add(nested)
    const message = nonEmptyString(nested.message) ?? findNestedMessage(nested, visited)
    if (message) return message
  }

  for (const nested of Object.values(value)) {
    if (!isRecord(nested) || visited.has(nested)) continue
    visited.add(nested)
    const message = nonEmptyString(nested.message) ?? findNestedMessage(nested, visited)
    if (message) return message
  }
  return null
}

function findNestedCode(value: Record<string, unknown>, visited: Set<object>): string | null {
  for (const nested of Object.values(value)) {
    if (!isRecord(nested) || visited.has(nested)) continue
    visited.add(nested)
    const code = nonEmptyString(nested.code) ?? findNestedCode(nested, visited)
    if (code) return code
  }
  return null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
