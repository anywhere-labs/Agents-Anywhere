import { AgentDevice } from '../../model/AgentSession';

/**
 * Pairing monitor.
 *
 * Port of `feature/devices/DevicePairingMonitor.kt`.
 *
 * While a connector is being started, the app polls that device until it comes
 * online, so the wizard can close itself the moment the device appears. Android
 * keeps this state in the authenticated app scope, which is why leaving the setup
 * page does not cancel a wait.
 *
 * Two details are worth keeping: the first poll is delayed by 1.5s so a connector
 * that is still booting is not asked immediately, and a *terminal* HTTP status —
 * a 404 for a device that no longer exists, say — stops the wait instead of
 * polling a dead id forever. Transient statuses (408, 409, 425, 429) keep going.
 *
 * ArkTS has no coroutines, so the loop lives in the app and this type owns the
 * state and the decision table; `pairingPollDelayMs` and
 * `isTerminalPairingStatus` are pure so they can be checked directly.
 */

export class DevicePairingStatus {
  static readonly WAITING: string = 'waiting';
  static readonly ONLINE: string = 'online';
}

/** Android's first-poll delay and its two retry intervals, in milliseconds. */
export const PAIRING_INITIAL_DELAY_MS: number = 1500;
export const PAIRING_POLL_INTERVAL_MS: number = 2000;
export const PAIRING_POLL_FAILURE_INTERVAL_MS: number = 3000;

const TRANSIENT_STATUSES: number[] = [408, 409, 425, 429];

/**
 * True when a failed poll means "stop waiting".
 *
 * A status of 0 is a transport failure rather than a Server answer, and 5xx or
 * the transient codes above are worth retrying; anything else is final.
 */
export function isTerminalPairingStatus(status: number): boolean {
  if (status === 0) {
    return false;
  }
  if (TRANSIENT_STATUSES.includes(status)) {
    return false;
  }
  return status < 500 ? true : false;
}

/** The delay before the next poll, given whether the last one failed. */
export function pairingPollDelayMs(failed: boolean, first: boolean): number {
  if (first) {
    return PAIRING_INITIAL_DELAY_MS;
  }
  return failed ? PAIRING_POLL_FAILURE_INTERVAL_MS : PAIRING_POLL_INTERVAL_MS;
}

export class DevicePairingMonitor {
  private readonly statuses: Map<string, string> = new Map();

  /** Marks a device as being waited on. */
  waitForDevice(id: string): DevicePairingMonitor {
    const next: Map<string, string> = new Map(this.statuses);
    next.set(id, DevicePairingStatus.WAITING);
    return new DevicePairingMonitor().with(next);
  }

  /** Stops waiting for a device, whatever its state was. */
  clear(id: string): DevicePairingMonitor {
    const next: Map<string, string> = new Map(this.statuses);
    next.delete(id);
    return new DevicePairingMonitor().with(next);
  }

  /** Records that a waited-on device came online. */
  markOnline(id: string): DevicePairingMonitor {
    if (!this.statuses.has(id)) {
      return this;
    }
    const next: Map<string, string> = new Map(this.statuses);
    next.set(id, DevicePairingStatus.ONLINE);
    return new DevicePairingMonitor().with(next);
  }

  statusFor(id: string): string | null {
    return this.statuses.get(id) ?? null;
  }

  pendingIds(): string[] {
    const ids: string[] = [];
    this.statuses.forEach((status: string, id: string) => {
      if (status === DevicePairingStatus.WAITING) {
        ids.push(id);
      }
    });
    return ids;
  }

  /** True when a device is either waited on or already reported online. */
  isTracked(id: string): boolean {
    return this.statuses.has(id);
  }

  private with(next: Map<string, string>): DevicePairingMonitor {
    const monitor: DevicePairingMonitor = new DevicePairingMonitor();
    next.forEach((status: string, id: string) => {
      monitor.statuses.set(id, status);
    });
    return monitor;
  }
}

/** True when a device the wizard is tracking is online right now. */
export function pairingDeviceOnline(
  monitor: DevicePairingMonitor,
  devices: AgentDevice[],
  deviceId: string,
): boolean {
  if (monitor.statusFor(deviceId) === DevicePairingStatus.ONLINE) {
    return true;
  }
  for (const device of devices) {
    if (device.id === deviceId && device.online) {
      return true;
    }
  }
  return false;
}
