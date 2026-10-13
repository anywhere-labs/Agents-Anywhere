import {
  DeviceRuntimeStatus, RemoteDeviceRuntime, RemoteDeviceRuntimeList,
} from '../../api/DevicesDtos';

/**
 * Runtime management state for the device detail page.
 *
 * Port of the list-management half of `feature/devices/DeviceRuntimeState.kt`.
 *
 * The screen shows the *configured* runtimes in a fixed order — Codex, Claude,
 * DSH, then everything else by name — with a status dot, a switch and a delete
 * button each. Only one operation may be in flight at a time, which is what
 * `pendingRuntimeId` enforces.
 */

/** Android's `deviceRuntimeComparator`: known runtimes first, then by name. */
export function compareDeviceRuntimes(left: RemoteDeviceRuntime, right: RemoteDeviceRuntime): number {
  const leftRank: number = runtimeRank(left.type);
  const rightRank: number = runtimeRank(right.type);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  const leftName: string = left.displayName.toLowerCase();
  const rightName: string = right.displayName.toLowerCase();
  if (leftName === rightName) {
    return 0;
  }
  return leftName < rightName ? -1 : 1;
}

function runtimeRank(type: string): number {
  if (type === 'codex') {
    return 0;
  }
  if (type === 'claude') {
    return 1;
  }
  if (type === 'dsh') {
    return 2;
  }
  return 99;
}

export class DeviceRuntimeManagementState {
  readonly connectorId: string | null;
  readonly runtimes: RemoteDeviceRuntime[];
  readonly loading: boolean;
  readonly discovering: boolean;
  /** Runtime whose activation is in flight; only one at a time. */
  readonly pendingRuntimeId: string | null;
  readonly errorMessage: string | null;
  readonly errorFromDiscovery: boolean;

  constructor(
    connectorId: string | null,
    runtimes: RemoteDeviceRuntime[],
    loading: boolean,
    discovering: boolean,
    pendingRuntimeId: string | null,
    errorMessage: string | null,
    errorFromDiscovery: boolean,
  ) {
    this.connectorId = connectorId;
    this.runtimes = runtimes;
    this.loading = loading;
    this.discovering = discovering;
    this.pendingRuntimeId = pendingRuntimeId;
    this.errorMessage = errorMessage;
    this.errorFromDiscovery = errorFromDiscovery;
  }

  static empty(): DeviceRuntimeManagementState {
    return new DeviceRuntimeManagementState(null, [], false, false, null, null, false);
  }

  /** The state a page shows while it waits for the first inventory. */
  static loadingFor(connectorId: string): DeviceRuntimeManagementState {
    return new DeviceRuntimeManagementState(connectorId, [], true, false, null, null, false);
  }

  copy(patch: DeviceRuntimePatch): DeviceRuntimeManagementState {
    return new DeviceRuntimeManagementState(
      patch.connectorId !== undefined ? patch.connectorId : this.connectorId,
      patch.runtimes ?? this.runtimes,
      patch.loading ?? this.loading,
      patch.discovering ?? this.discovering,
      patch.pendingRuntimeId !== undefined ? patch.pendingRuntimeId : this.pendingRuntimeId,
      patch.errorMessage !== undefined ? patch.errorMessage : this.errorMessage,
      patch.errorFromDiscovery ?? this.errorFromDiscovery,
    );
  }

  configuredRuntimes(): RemoteDeviceRuntime[] {
    return this.runtimes
      .filter((runtime: RemoteDeviceRuntime) => runtime.configured)
      .sort(compareDeviceRuntimes);
  }

  discoveredUnconfiguredRuntimes(): RemoteDeviceRuntime[] {
    return this.runtimes
      .filter((runtime: RemoteDeviceRuntime) => runtime.present && !runtime.configured)
      .sort(compareDeviceRuntimes);
  }

  /** Applies a whole inventory, clearing every in-flight marker. */
  replaceWithList(result: RemoteDeviceRuntimeList): DeviceRuntimeManagementState {
    return new DeviceRuntimeManagementState(
      result.connectorId,
      result.runtimes.slice().sort(compareDeviceRuntimes),
      false,
      false,
      null,
      null,
      false,
    );
  }

  /** Applies one runtime from an activation reply. */
  replaceRuntime(runtime: RemoteDeviceRuntime): DeviceRuntimeManagementState {
    const next: RemoteDeviceRuntime[] = [];
    let replaced: boolean = false;
    for (const current of this.runtimes) {
      if (current.id === runtime.id) {
        next.push(runtime);
        replaced = true;
      } else {
        next.push(current);
      }
    }
    if (!replaced) {
      next.push(runtime);
    }
    return new DeviceRuntimeManagementState(
      runtime.connectorId,
      next.slice().sort(compareDeviceRuntimes),
      this.loading,
      this.discovering,
      null,
      null,
      false,
    );
  }

  discoveryFailed(message: string): DeviceRuntimeManagementState {
    return this.copy({ discovering: false, errorMessage: message, errorFromDiscovery: true });
  }

  /** True while an activation is in flight, which disables every row's controls. */
  operationsEnabled(): boolean {
    return this.pendingRuntimeId === null && !this.discovering;
  }
}

export interface DeviceRuntimePatch {
  connectorId?: string | null;
  runtimes?: RemoteDeviceRuntime[];
  loading?: boolean;
  discovering?: boolean;
  pendingRuntimeId?: string | null;
  errorMessage?: string | null;
  errorFromDiscovery?: boolean;
}

/** True when the runtime can be switched on: present and configured. */
export function runtimeCanActivate(runtime: RemoteDeviceRuntime): boolean {
  return runtime.present && runtime.configured;
}

/**
 * The instance of a type that can be configured again.
 *
 * iOS's `V2RuntimeInventory.reconfigurableInstance(for:)`: the Server keeps the
 * identity and history of a cleared instance, so adding that type reuses it
 * instead of creating a second one.
 */
export function reconfigurableRuntime(
  runtimes: RemoteDeviceRuntime[],
  runtimeType: string,
): RemoteDeviceRuntime | null {
  for (const runtime of runtimes) {
    if (runtime.type === runtimeType && !runtime.configured) {
      return runtime;
    }
  }
  return null;
}

/** The instance of a type with the given name, or `null`. */
export function runtimeNamed(
  runtimes: RemoteDeviceRuntime[],
  runtimeType: string,
  name: string,
): RemoteDeviceRuntime | null {
  for (const runtime of runtimes) {
    if (runtime.type === runtimeType && runtime.displayName === name) {
      return runtime;
    }
  }
  return null;
}

/** The configured instance of a type, or `null`; iOS's `configuredInstances.first`. */
export function configuredRuntime(
  runtimes: RemoteDeviceRuntime[],
  runtimeType: string,
): RemoteDeviceRuntime | null {
  for (const runtime of runtimes) {
    if (runtime.type === runtimeType && runtime.configured) {
      return runtime;
    }
  }
  return null;
}

/**
 * iOS's "nothing left to do" test: an active runtime in a live state.
 *
 * Adding a type that is already running is a no-op there, so a retry after a
 * start failure cannot restart a healthy instance.
 */
export function runtimeIsUp(runtime: RemoteDeviceRuntime): boolean {
  if (!runtime.configured || !runtime.active) {
    return false;
  }
  return runtime.status === DeviceRuntimeStatus.RUNNING
    || runtime.status === DeviceRuntimeStatus.STARTING;
}
