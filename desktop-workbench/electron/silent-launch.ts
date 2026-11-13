import type { OwnershipState } from "./local-runtime";

/**
 * `holding`  : the silent login-item launch is waiting for a result and keeps
 *              its window hidden.
 * `owned`    : the local lease is held, but a credential failure can still
 *              reveal the window.
 * `inactive` : this is a regular launch.
 * `revealed` : the window has been opened, consuming the silent-launch reveal.
 */
export type SilentLaunchState = "holding" | "owned" | "inactive" | "revealed";

/** States the user has to resolve before this machine can be used. */
export function ownershipNeedsWindow(status: OwnershipState["status"]): boolean {
  return status === "conflict" || status === "error";
}

/**
 * Ownership is resolved asynchronously by the backend, and on a cold boot the
 * Connector can take minutes to start, so the launch has to wait for a result
 * instead of a fixed timeout. `checking` and `preparing` are transient and keep
 * the window hidden. Once the lease is held, Connector authentication can
 * still fail asynchronously, even after the runtime first reports running.
 */
export function nextSilentLaunchState(
  current: SilentLaunchState,
  status: OwnershipState["status"],
  authFailed: boolean,
): SilentLaunchState {
  if (current === "holding" && ownershipNeedsWindow(status)) return "revealed";
  if (current === "owned" || (current === "holding" && status === "owned")) {
    return authFailed ? "revealed" : "owned";
  }
  return current;
}

export interface SilentLaunchDecision {
  /** From the settings file or the Connector. `undefined` means "not known yet". */
  silentLaunch: boolean | undefined;
  /** True when the OS login item or an updater started this process. */
  openedAsLoginItem: boolean;
  /** Set when a web build is being pointed at explicitly (dev/staging). */
  webUrlOverride: string | undefined;
}

/**
 * Decide whether this launch should stay hidden. Kept separate from the main
 * process so the three inputs can be tested directly: the settings value is not
 * available from the Connector until long after startup, and treating that gap
 * as `false` reveals the window on every login-item start.
 */
export function shouldLaunchSilently(decision: SilentLaunchDecision): boolean {
  return decision.silentLaunch === true
    && decision.openedAsLoginItem
    && !decision.webUrlOverride;
}
