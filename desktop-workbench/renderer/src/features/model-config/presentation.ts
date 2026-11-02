import type {
  DeviceRuntimeView,
  ModelAssignmentStatus,
  ModelConnectionState,
  RuntimeMaturity,
} from "@/features/dashboard/types"

export type ModelStatusTone = "ok" | "progress" | "warning" | "error" | "neutral"

/** Stable runtimes show no badge; the others say how far along they are. */
export function maturityBadge(maturity: RuntimeMaturity | null | undefined): "experimental" | "beta" | null {
  return maturity === "beta" || maturity === "experimental" ? maturity : null
}

export function connectionStateTone(state: ModelConnectionState | undefined): ModelStatusTone {
  if (state === "applied") return "ok"
  if (state === "saved_pending") return "progress"
  if (state === "failed") return "error"
  if (state === "managed_externally") return "warning"
  return "neutral"
}

export function assignmentStatusTone(status: ModelAssignmentStatus): ModelStatusTone {
  if (status === "applied") return "ok"
  if (status === "applying") return "progress"
  if (status === "failed") return "error"
  return "warning"
}

/** Runtimes the page lists: every instance that declares a model connection. */
export function modelConfigurableRuntimes(runtimes: DeviceRuntimeView[]): DeviceRuntimeView[] {
  return runtimes.filter((runtime) => Boolean(runtime.modelConnection))
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Model IDs parsed from a free-form list: one per line or separated by commas. */
export function parseModelIds(text: string): string[] {
  const seen = new Set<string>()
  for (const raw of text.split(/[\n,]/)) {
    const id = raw.trim()
    if (id) seen.add(id)
  }
  return [...seen]
}
