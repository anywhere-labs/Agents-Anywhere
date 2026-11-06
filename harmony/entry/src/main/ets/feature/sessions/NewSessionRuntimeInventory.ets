import { DeviceRuntimeStatus, RemoteDeviceRuntime } from '../../api/DevicesDtos';

/**
 * Which runtimes the new-session page may offer, and when the list is settled.
 *
 * Port of `feature/sessions/NewSessionRuntimeInventory.kt`.
 *
 * Only a runtime that is present, configured, switched on *and* reported as
 * running can host a session, and the page asks for the inventory again until
 * every runtime that is switched on has finished starting — an inventory that is
 * still starting would otherwise offer a runtime the Server would reject.
 */

/** Runtimes a session can be started on, by display name then id. */
export function activeNewSessionRuntimes(
  runtimes: RemoteDeviceRuntime[],
): RemoteDeviceRuntime[] {
  const active: RemoteDeviceRuntime[] = runtimes.filter(
    (runtime: RemoteDeviceRuntime) => runtime.configured && runtime.active
      && runtime.status === DeviceRuntimeStatus.RUNNING,
  );
  return active.sort((left: RemoteDeviceRuntime, right: RemoteDeviceRuntime) => {
    const leftName: string = left.displayName.toLowerCase();
    const rightName: string = right.displayName.toLowerCase();
    if (leftName !== rightName) {
      return leftName < rightName ? -1 : 1;
    }
    if (left.id === right.id) {
      return 0;
    }
    return left.id < right.id ? -1 : 1;
  });
}

/** True while the inventory should be fetched again. */
export function newSessionInventoryNeedsSettling(
  runtimes: RemoteDeviceRuntime[],
): boolean {
  if (runtimes.length === 0) {
    return true;
  }
  return runtimes.some((runtime: RemoteDeviceRuntime) => runtime.configured && runtime.active
    && runtime.status !== DeviceRuntimeStatus.RUNNING);
}
