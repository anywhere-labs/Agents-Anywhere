import type { PlanDocument, PlanningState } from "@/generated/protocol/v1/planning-state"
import type { TimelineItem } from "@/features/dashboard/types"

/** Plan text that a runtime also echoed as a system message; the plan card shows it instead. */
export function planEchoFilter(state: PlanningState | null, documents: PlanDocument[]) {
  const texts = new Set(documents.map(document => (document.markdown ?? "").trim()).filter(Boolean))
  const draft = (state?.draft?.content ?? "").trim()
  return (item: TimelineItem, text: string) => {
    if (item.role !== "system") return true
    const value = text.trim()
    if (!value) return true
    return !(texts.has(value) || (draft !== "" && draft.startsWith(value)))
  }
}

type PlacementGroup = { key: string; items: TimelineItem[] }

/**
 * A plan sits before the first user message that followed it. An approved plan
 * therefore lands directly above the implementation it started; one still under
 * review has no later user message and stays at the end, beside the composer.
 */
export function placePlanDocuments(documents: PlanDocument[], groups: PlacementGroup[]) {
  const before = new Map<string, PlanDocument[]>()
  const end: PlanDocument[] = []
  const userTimes = groups.map(group => {
    const times = group.items
      .filter(item => item.role === "user")
      .map(item => Date.parse(item.createdAt))
      .filter(Number.isFinite)
    return times.length ? Math.min(...times) : null
  })
  const ordered = [...documents].sort((a, b) => planTime(a) - planTime(b) || a.revision - b.revision)
  for (const document of ordered) {
    const at = planTime(document)
    const index = Number.isFinite(at) ? userTimes.findIndex(time => time !== null && time > at) : -1
    if (index < 0) { end.push(document); continue }
    const key = groups[index]!.key
    before.set(key, [...(before.get(key) ?? []), document])
  }
  return { before, end }
}

function planTime(document: PlanDocument) {
  return typeof document.createdAt === "string" ? Date.parse(document.createdAt) : Number.NaN
}

/** Newest revision of each plan; older ones are shown as superseded rows. */
export function latestPlanRevisions(documents: PlanDocument[]) {
  const latest = new Map<string, number>()
  for (const document of documents) latest.set(document.planId, Math.max(latest.get(document.planId) ?? 0, document.revision))
  return latest
}

export type PlanStatusKey =
  | "statusOpen" | "statusResponding" | "statusApproved" | "statusExecuted" | "statusExecutionPending"
  | "statusRevisionRequested" | "statusDismissed" | "statusWithdrawn" | "statusUnknown"

/** Review outcome of this exact version, as a `planning.*` message key. */
export function planReviewStatus(state: PlanningState | null, document: PlanDocument): PlanStatusKey | null {
  const review = state?.review
  if (!review || review.planId !== document.planId || review.planRevision !== document.revision) return null
  if (review.status === "approved") {
    const execution = state?.execution?.status
    return execution === "started" ? "statusExecuted" : execution === "rejected" ? "statusExecutionPending" : "statusApproved"
  }
  const keys: Partial<Record<string, PlanStatusKey>> = {
    open: "statusOpen", responding: "statusResponding", revision_requested: "statusRevisionRequested",
    dismissed: "statusDismissed", withdrawn: "statusWithdrawn", unknown: "statusUnknown",
  }
  return keys[review.status] ?? null
}
