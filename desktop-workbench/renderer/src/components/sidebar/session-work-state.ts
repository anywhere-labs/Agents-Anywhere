/** Plan and goal state from the session list (protocol 1.2); the Server keeps it, so it shows while the device is offline. */
export type SessionWorkState = "planReview" | "goalActive" | "goalPaused"

export function sessionWorkState(item: { planState?: string | null; goalState?: string | null }): SessionWorkState | null {
  if (item.planState === "awaiting_review") return "planReview"
  if (item.goalState === "paused") return "goalPaused"
  if (item.goalState === "active") return "goalActive"
  return null
}
