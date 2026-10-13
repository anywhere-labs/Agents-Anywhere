import { AgentDevice } from '../../model/AgentSession';
import { DeviceRuntimeStatus, RemoteDeviceRuntime, RemoteDeviceRuntimeList } from '../../api/DevicesDtos';

/**
 * Device list ordering and agent previews.
 *
 * Port of `feature/devices/DeviceAgentPreviewState.kt` and the ordering helper in
 * `ui/screens/devices/DevicesScreen.kt`.
 *
 * The preview answers "how many agents are running on this device" without
 * loading the whole runtime inventory into the screen: each online device is
 * asked once per refresh, and a generation counter rejects a reply that belongs
 * to a superseded refresh. A device that answered once keeps its count while the
 * next refresh is in flight, so the row does not flicker back to "loading".
 */

export enum DeviceAgentPreviewKind {
  Loading = 0,
  Loaded = 1,
  Unavailable = 2,
}

export interface DeviceAgentPreview {
  kind: DeviceAgentPreviewKind;
  onlineAgentCount: number;
}

export function loadingPreview(): DeviceAgentPreview {
  return { kind: DeviceAgentPreviewKind.Loading, onlineAgentCount: 0 };
}

/**
 * Previews keyed by device id, with the refresh generation that produced them.
 *
 * `byDeviceId` is a `Map` rather than a plain object because ArkTS cannot index
 * an object by an arbitrary string without a record type.
 */
export class DeviceAgentPreviews {
  readonly generation: number;
  readonly byDeviceId: Map<string, DeviceAgentPreview>;

  constructor(generation: number, byDeviceId: Map<string, DeviceAgentPreview>) {
    this.generation = generation;
    this.byDeviceId = byDeviceId;
  }

  static empty(): DeviceAgentPreviews {
    return new DeviceAgentPreviews(0, new Map<string, DeviceAgentPreview>());
  }

  /** Starts a refresh: only the online devices are in scope, and a loaded count
   *  survives so the row keeps showing it while the new request is in flight. */
  beginRefresh(onlineDeviceIds: string[]): DeviceAgentPreviews {
    const next: Map<string, DeviceAgentPreview> = new Map<string, DeviceAgentPreview>();
    for (const deviceId of onlineDeviceIds) {
      const current: DeviceAgentPreview | undefined = this.byDeviceId.get(deviceId);
      next.set(
        deviceId,
        current !== undefined && current.kind === DeviceAgentPreviewKind.Loaded
          ? current
          : loadingPreview(),
      );
    }
    return new DeviceAgentPreviews(this.generation + 1, next);
  }

  preview(deviceId: string): DeviceAgentPreview | undefined {
    return this.byDeviceId.get(deviceId);
  }

  /** Applies a count, ignoring a reply from a superseded refresh. */
  loaded(requestGeneration: number, deviceId: string, onlineAgentCount: number): DeviceAgentPreviews {
    if (requestGeneration !== this.generation || !this.byDeviceId.has(deviceId)) {
      return this;
    }
    const next: Map<string, DeviceAgentPreview> = new Map<string, DeviceAgentPreview>(this.byDeviceId);
    next.set(deviceId, { kind: DeviceAgentPreviewKind.Loaded, onlineAgentCount: onlineAgentCount });
    return new DeviceAgentPreviews(this.generation, next);
  }

  /**
   * Marks a device unavailable, unless it already reported a count.
   *
   * A failed refresh must not blank out a number the user is reading.
   */
  failed(requestGeneration: number, deviceId: string): DeviceAgentPreviews {
    const current: DeviceAgentPreview | undefined = this.byDeviceId.get(deviceId);
    if (requestGeneration !== this.generation || current === undefined
      || current.kind === DeviceAgentPreviewKind.Loaded) {
      return this;
    }
    const next: Map<string, DeviceAgentPreview> = new Map<string, DeviceAgentPreview>(this.byDeviceId);
    next.set(deviceId, { kind: DeviceAgentPreviewKind.Unavailable, onlineAgentCount: 0 });
    return new DeviceAgentPreviews(this.generation, next);
  }
}

/**
 * Agents this device is running.
 *
 * Android counts a runtime as an online agent only when it is configured and
 * active and reports `running`; a discovered-but-unconfigured runtime is not an
 * agent the user can talk to yet.
 */
export function onlineAgentCount(runtimes: RemoteDeviceRuntime[]): number {
  let count: number = 0;
  for (const runtime of runtimes) {
    if (runtime.configured && runtime.active && runtime.status === DeviceRuntimeStatus.RUNNING) {
      count++;
    }
  }
  return count;
}

export function onlineAgentCountForList(list: RemoteDeviceRuntimeList): number {
  return onlineAgentCount(list.runtimes);
}

/**
 * Devices page order: online first, then oldest first, then by name.
 *
 * Android's `sortedForDevicesPage`; the comparison is case-insensitive on the
 * name so a device list does not sort `Zed` before `alpha`.
 */
export function sortedForDevicesPage(devices: AgentDevice[]): AgentDevice[] {
  const sorted: AgentDevice[] = devices.slice();
  sorted.sort((left: AgentDevice, right: AgentDevice) => {
    if (left.online !== right.online) {
      return left.online ? -1 : 1;
    }
    const leftCreated: string = left.createdAt ?? '';
    const rightCreated: string = right.createdAt ?? '';
    if (leftCreated !== rightCreated) {
      return leftCreated < rightCreated ? -1 : 1;
    }
    const leftName: string = left.name.toLowerCase();
    const rightName: string = right.name.toLowerCase();
    if (leftName === rightName) {
      return 0;
    }
    return leftName < rightName ? -1 : 1;
  });
  return sorted;
}
