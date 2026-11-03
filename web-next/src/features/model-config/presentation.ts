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

export type QuickSetupPhase = "setup" | "progress" | "done"
export type QuickStepStatus = "pending" | "active" | "done" | "failed"
type QuickTokens = {
  link: { status: "linked" | "reauth_required" } | null
  quickSetup?: { state: "syncing" | "applying" | "done" | "failed"; step?: "sync" | "apply" } | null
}
type QuickCandidate = {
  connectorId: string
  runtimeId: string
  decision: "apply" | "skip"
  requiresConfirmation?: boolean
}

export const quickTargetKey = (target: { connectorId: string; runtimeId: string }) =>
  `${target.connectorId}/${target.runtimeId}`

/**
 * Which face the Tokens Anywhere card shows: choosing what to set up, a setup
 * on its way (including the browser authorization this page started), or the
 * result once runtimes use the Tokens profile.
 */
export function quickSetupPhase(tokens: QuickTokens, configured: boolean, authorizing: boolean): QuickSetupPhase {
  const state = tokens.quickSetup?.state
  if (authorizing && tokens.link?.status !== "linked") return "progress"
  if (state === "syncing" || state === "applying" || state === "failed") return tokens.link?.status === "linked" ? "progress" : "setup"
  if (tokens.link?.status === "linked" && (configured || state === "done")) return "done"
  return "setup"
}

export function quickSetupSteps(tokens: QuickTokens, authorizing: boolean): Record<"authorize" | "sync" | "apply", QuickStepStatus> {
  const linked = tokens.link?.status === "linked"
  const progress = tokens.quickSetup
  if (!linked) return { authorize: authorizing ? "active" : "pending", sync: "pending", apply: "pending" }
  if (!progress) return { authorize: "done", sync: "pending", apply: "pending" }
  if (progress.state === "failed") {
    return progress.step === "sync"
      ? { authorize: "done", sync: "failed", apply: "pending" }
      : { authorize: "done", sync: "done", apply: "failed" }
  }
  if (progress.state === "syncing") return { authorize: "done", sync: "active", apply: "pending" }
  if (progress.state === "applying") return { authorize: "done", sync: "done", apply: "active" }
  return { authorize: "done", sync: "done", apply: "done" }
}

/** Ticked by default: everything that can be applied without changing a runtime's own global settings. */
export function defaultQuickSelection(candidates: QuickCandidate[]): Set<string> {
  return new Set(candidates.filter((item) => item.decision === "apply" && !item.requiresConfirmation).map(quickTargetKey))
}

/**
 * Runtimes that could use Tokens Anywhere but do not yet. A runtime served by
 * a managed instance counts as set up: the instance carries the assignment.
 */
export function newQuickCandidates<T extends QuickCandidate & { runtimeType?: string; effect?: string }>(
  candidates: T[],
  assigned: { connectorId: string; runtimeId: string; runtimeType?: string; createdRuntime?: boolean }[],
): T[] {
  const taken = new Set(assigned.map(quickTargetKey))
  const managed = new Set(assigned.filter((item) => item.createdRuntime && item.runtimeType).map((item) => `${item.connectorId}/${item.runtimeType}`))
  return candidates.filter((item) => item.decision === "apply"
    && !taken.has(quickTargetKey(item))
    && !(item.effect === "new_instance" && managed.has(`${item.connectorId}/${item.runtimeType}`)))
}
