import type { OwnershipState } from "./local-runtime";

/**
 * `holding`  : the silent login-item launch is waiting for a result and keeps
 *              its window hidden.
 * `settled`  : ownership is `owned`, so the launch stays silent for good.
 * `revealed` : ownership needs the user, so the window is shown once.
 */
export type SilentLaunchState = "holding" | "settled" | "revealed";

/** States the user has to resolve before this machine can be used. */
export function ownershipNeedsWindow(status: OwnershipState["status"]): boolean {
  return status === "conflict" || status === "error";
}

/**
 * Ownership is resolved asynchronously by the backend, and on a cold boot the
 * Connector can take minutes to start, so the launch has to wait for a result
 * instead of a fixed timeout. `checking` and `preparing` are transient and keep
 * the window hidden; `owned` ends the wait silently, and the two states that
 * need the user reveal it.
 */
export function nextSilentLaunchState(
  current: SilentLaunchState,
  status: OwnershipState["status"],
): SilentLaunchState {
  if (current !== "holding") return current;
  if (ownershipNeedsWindow(status)) return "revealed";
  return status === "owned" ? "settled" : "holding";
}
