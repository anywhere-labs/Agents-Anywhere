import { RemoteDeviceRuntimeList } from '../../api/DevicesDtos';
import { activeNewSessionRuntimes, newSessionInventoryNeedsSettling } from './NewSessionRuntimeInventory';

/**
 * The new-session page's runtime inventory.
 *
 * Port of the loader in `ui/screens/home/NewSessionRuntimeInventory.kt`.
 *
 * The page has to wait for two things before it can offer an Agent: the device
 * list, and then each online device's runtime inventory. An inventory is not
 * final on the first answer either — a runtime that is switched on but still
 * starting will become usable a moment later — so each connector is polled until
 * its inventory settles, giving up after five attempts.
 *
 * Android keeps this state in Compose `mutableStateOf` fields; here it is a plain
 * object plus an `onChanged` callback, so the screen can bump its own state
 * counter whenever an answer lands.
 */

/** Android's retry ladder: 500 ms, then doubling, five attempts in total. */
export const INVENTORY_RETRY_DELAYS: number[] = [500, 1000, 2000, 4000, 8000];

/** Android gives a single inventory request 10 seconds. */
export const INVENTORY_TIMEOUT_MS: number = 10_000;

/** The delays a connector has left, in order. */
function retryDelayFor(attempt: number, delays: number[]): number {
  return attempt < delays.length ? delays[attempt] : -1;
}

function delayMillis(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve: () => void) => {
    setTimeout(() => resolve(), milliseconds);
  });
}

/** Rejects when the loader does not answer in time, with Android's message. */
function withTimeout(
  work: Promise<RemoteDeviceRuntimeList>,
  timeoutMs: number,
  message: string,
): Promise<RemoteDeviceRuntimeList> {
  return new Promise<RemoteDeviceRuntimeList>(
    (resolve: (value: RemoteDeviceRuntimeList) => void, reject: (error: Error) => void) => {
      let settled: boolean = false;
      const timer: number = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
      }, timeoutMs);
      work.then((value: RemoteDeviceRuntimeList) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      }).catch((error: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
    },
  );
}

export class NewSessionRuntimeInventory {
  results: Map<string, RemoteDeviceRuntimeList> = new Map();
  errors: Map<string, string> = new Map();
  pendingInitial: Set<string> = new Set();
  hasLoaded: boolean = false;
  /** Bumped by `refresh()`, and passed to `loadAll` so a stale run stops. */
  private version: number = 0;

  /** Notified after every change, so a screen can re-read this object. */
  onChanged: () => void = () => {};

  refreshVersion(): number {
    return this.version;
  }

  refresh(): void {
    this.version += 1;
  }

  /**
   * True until the first load finishes, and afterwards while nothing usable has
   * arrived from the connectors that are still pending.
   */
  loading(): boolean {
    if (!this.hasLoaded) {
      return true;
    }
    if (this.pendingInitial.size === 0) {
      return false;
    }
    for (const list of this.results.values()) {
      if (activeNewSessionRuntimes(list.runtimes).length > 0) {
        return false;
      }
    }
    return true;
  }

  /** The inventory of one connector, or `null` before it has answered. */
  listFor(connectorId: string): RemoteDeviceRuntimeList | null {
    const value: RemoteDeviceRuntimeList | undefined = this.results.get(connectorId);
    return value === undefined ? null : value;
  }

  runtimeListFor(connectorId: string): string[] {
    const list: RemoteDeviceRuntimeList | null = this.listFor(connectorId);
    return list === null ? [] : activeNewSessionRuntimes(list.runtimes).map((runtime) => runtime.id);
  }

  /**
   * Loads every connector, retrying each one until its inventory settles.
   *
   * `version` is the value `refreshVersion()` had when the caller started: a
   * refresh during the run abandons the answers instead of mixing generations.
   * The last two parameters are the retry ladder and the per-attempt timeout,
   * exposed so a test can run the policy without waiting half a minute; callers
   * pass nothing and get Android's values.
   */
  async loadAll(
    connectorIds: string[],
    load: (connectorId: string) => Promise<RemoteDeviceRuntimeList>,
    loadError: string,
    version: number = this.version,
    retryDelays: number[] = INVENTORY_RETRY_DELAYS,
    timeoutMs: number = INVENTORY_TIMEOUT_MS,
  ): Promise<void> {
    const ids: string[] = [];
    for (const id of connectorIds) {
      if (id.length > 0 && !ids.includes(id)) {
        ids.push(id);
      }
    }
    ids.sort();

    for (const key of Array.from(this.results.keys())) {
      if (!ids.includes(key)) {
        this.results.delete(key);
      }
    }
    for (const key of Array.from(this.errors.keys())) {
      if (!ids.includes(key)) {
        this.errors.delete(key);
      }
    }
    this.pendingInitial = new Set(ids);
    if (ids.length === 0) {
      this.hasLoaded = true;
    }
    this.onChanged();

    const work: Promise<void>[] = [];
    for (const id of ids) {
      work.push(this.loadOne(id, load, loadError, version, retryDelays, timeoutMs));
    }
    await Promise.all(work);
  }

  private async loadOne(
    connectorId: string,
    load: (connectorId: string) => Promise<RemoteDeviceRuntimeList>,
    loadError: string,
    version: number,
    retryDelays: number[],
    timeoutMs: number,
  ): Promise<void> {
    let attempt: number = 0;
    while (true) {
      let result: RemoteDeviceRuntimeList | null = null;
      let failure: string = '';
      try {
        result = await withTimeout(load(connectorId), timeoutMs, loadError);
      } catch (error) {
        failure = error instanceof Error ? error.message : loadError;
      }
      if (version !== this.version) {
        // A refresh started while this answer was in flight.
        return;
      }
      if (result !== null) {
        this.results.set(connectorId, result);
        this.errors.delete(connectorId);
      } else {
        this.errors.set(connectorId, failure.length > 0 ? failure : loadError);
      }
      this.pendingInitial.delete(connectorId);
      if (this.pendingInitial.size === 0) {
        this.hasLoaded = true;
      }
      this.onChanged();

      const settling: boolean = result === null
        ? true : newSessionInventoryNeedsSettling(result.runtimes);
      const delay: number = retryDelayFor(attempt, retryDelays);
      attempt += 1;
      if (!settling || delay < 0) {
        return;
      }
      await delayMillis(delay);
      if (version !== this.version) {
        return;
      }
    }
  }
}
