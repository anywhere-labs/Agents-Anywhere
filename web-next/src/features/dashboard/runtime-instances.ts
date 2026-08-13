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

function compareRuntimeTypes(
  left: RuntimeTypeDescriptorLike,
  right: RuntimeTypeDescriptorLike,
): number {
  const leftRank = left.recommendationRank ?? Number.MAX_SAFE_INTEGER
  const rightRank = right.recommendationRank ?? Number.MAX_SAFE_INTEGER
  return leftRank - rightRank || left.displayName.localeCompare(right.displayName)
}
