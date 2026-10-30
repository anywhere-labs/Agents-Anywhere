import { DeviceRuntimeStatus } from '../../../api/DevicesDtos';
import { AgentDevice } from '../../../model/AgentSession';
import { activeNewSessionRuntimes } from '../../../feature/sessions/NewSessionRuntimeInventory';
import { NewSessionRuntimeInventory } from '../../../feature/sessions/NewSessionRuntimeInventoryLoader';
import { SessionsState } from '../../../feature/sessions/SessionsState';

/**
 * Why the new-session page cannot offer any control yet.
 *
 * Port of `ui/screens/home/NewSessionSetupState.kt`.
 *
 * The page resolves its prerequisites in order — devices, then a device, then a
 * running Agent on it — and shows one explanation for whichever step is missing.
 * A session opened from a project is pinned to that project's device, so that
 * device is the only candidate and the "no devices" answer is what a missing one
 * reports.
 */

export enum NewSessionSetupReason {
  CheckingDevices = 0,
  DeviceLoadFailed = 1,
  NoDevices = 2,
  DevicesOffline = 3,
  CheckingAgents = 4,
  AgentLoadFailed = 5,
  NeedsAgentSetup = 6,
  NeedsAgentStart = 7,
  AgentStarting = 8,
}

export class NewSessionSetupState {
  readonly reason: NewSessionSetupReason;
  readonly device: AgentDevice | null;

  constructor(reason: NewSessionSetupReason, device: AgentDevice | null = null) {
    this.reason = reason;
    this.device = device;
  }
}

/** The setup state, or `null` once the page has everything it needs. */
export function newSessionSetupState(
  sessions: SessionsState,
  inventory: NewSessionRuntimeInventory,
  projectConnectorId: string | null,
  selectedConnectorId: string | null,
  hasSelectedRuntime: boolean,
): NewSessionSetupState | null {
  if (!sessions.hasLoaded) {
    return new NewSessionSetupState(
      sessions.errorMessage !== null && !sessions.isLoading
        ? NewSessionSetupReason.DeviceLoadFailed
        : NewSessionSetupReason.CheckingDevices,
    );
  }
  if (sessions.devices.length === 0) {
    return new NewSessionSetupState(
      sessions.errorMessage !== null
        ? NewSessionSetupReason.DeviceLoadFailed
        : NewSessionSetupReason.NoDevices,
    );
  }

  let projectDevice: AgentDevice | null = null;
  if (projectConnectorId !== null) {
    for (const device of sessions.devices) {
      if (device.id === projectConnectorId) {
        projectDevice = device;
        break;
      }
    }
    // A session opened from a project must stay on that project's device.
    if (projectDevice === null) {
      return new NewSessionSetupState(NewSessionSetupReason.NoDevices);
    }
  }
  const candidates: AgentDevice[] = projectDevice !== null
    ? [projectDevice] : sessions.devices;
  const online: AgentDevice[] = candidates.filter((device: AgentDevice) => device.online);

  let device: AgentDevice | null = projectDevice;
  if (device === null) {
    for (const candidate of online) {
      if (candidate.id === selectedConnectorId) {
        device = candidate;
        break;
      }
    }
  }
  if (device === null && online.length === 1) {
    device = online[0];
  }
  if (device === null && candidates.length === 1) {
    device = candidates[0];
  }

  if (online.length === 0) {
    return new NewSessionSetupState(NewSessionSetupReason.DevicesOffline, device);
  }
  if (hasSelectedRuntime && online.some((candidate) => candidate.id === selectedConnectorId)) {
    return null;
  }

  const ids: string[] = online.map((candidate) => candidate.id);
  const hasReadyAgent: boolean = ids.some((id: string) => {
    if (inventory.errors.has(id)) {
      return false;
    }
    const list = inventory.listFor(id);
    return activeNewSessionRuntimes(list === null ? [] : list.runtimes).length > 0;
  });
  const pending: boolean = ids.some((id: string) => inventory.pendingInitial.has(id)
    || (!inventory.results.has(id) && !inventory.errors.has(id)));
  if (hasReadyAgent || pending || !inventory.hasLoaded) {
    return new NewSessionSetupState(NewSessionSetupReason.CheckingAgents, device);
  }
  if (ids.some((id: string) => inventory.errors.has(id))) {
    return new NewSessionSetupState(NewSessionSetupReason.AgentLoadFailed, device);
  }

  let starting: boolean = false;
  let configured: boolean = false;
  let present: boolean = false;
  for (const id of ids) {
    const list = inventory.listFor(id);
    if (list === null) {
      continue;
    }
    for (const runtime of list.runtimes) {
      if (runtime.configured && runtime.present) {
        configured = true;
        present = true;
      }
      if (runtime.configured && runtime.active
        && (runtime.status === DeviceRuntimeStatus.STARTING
          || runtime.status === DeviceRuntimeStatus.VALIDATING
          || runtime.status === DeviceRuntimeStatus.DISCOVERING)) {
        starting = true;
      }
    }
  }
  if (starting) {
    return new NewSessionSetupState(NewSessionSetupReason.AgentStarting, device);
  }
  if (!configured || !present) {
    return new NewSessionSetupState(NewSessionSetupReason.NeedsAgentSetup, device);
  }
  return new NewSessionSetupState(NewSessionSetupReason.NeedsAgentStart, device);
}
