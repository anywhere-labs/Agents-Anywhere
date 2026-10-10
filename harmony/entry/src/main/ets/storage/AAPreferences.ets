import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { AALog } from '../common/AAAppLog';

/**
 * Named key-value stores, mirroring the Android `SharedPreferences` files.
 *
 * Android reads and writes these synchronously, and the whole client is written
 * against that assumption (for example `hasAuthSession()` decides the initial
 * destination during composition). HarmonyOS `preferences` offers synchronous
 * `getSync` / `putSync` but an asynchronous `flush`, so this class keeps the
 * synchronous read/write surface and fires the flush in the background.
 *
 * Store names are kept byte-identical to Android so the two clients remain
 * comparable when debugging, even though the platforms cannot share data.
 */
export class AAPreferenceNames {
  static readonly AUTH: string = 'agents_anywhere_auth';
  static readonly REALTIME: string = 'agents_anywhere_realtime';
  static readonly UI: string = 'agents_anywhere_ui';
  static readonly APP_UPDATES: string = 'app-updates';
  static readonly PROJECT_SIDEBAR: string = 'project_sidebar';
  static readonly NEW_SESSION: string = 'agents-anywhere-new-session';

  /** Android suffixes the draft store with the user id hash; keep the same shape. */
  static composerDrafts(userId: string): string {
    return `session-composer-drafts-${hashString(userId)}`;
  }
}

/**
 * Java-compatible `String.hashCode()`, used only to derive per-user store names.
 * The value never leaves the process, but matching Java keeps the generated
 * store names identical to Android's for easier cross-client debugging.
 */
export function hashString(value: string): number {
  let hash: number = 0;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

export class AAPreferences {
  private static context: common.Context | null = null;
  private static stores: Map<string, preferences.Preferences> = new Map();

  /** Called once from `EntryAbility.onCreate` before any screen composes. */
  static initialize(context: common.Context): void {
    AAPreferences.context = context;
  }

  static isInitialized(): boolean {
    return AAPreferences.context !== null;
  }

  static store(name: string): preferences.Preferences {
    const existing: preferences.Preferences | undefined = AAPreferences.stores.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const context: common.Context | null = AAPreferences.context;
    if (context === null) {
      throw new Error('AAPreferences.initialize must run before any store is opened.');
    }
    // getPreferencesSync may throw (corrupt file, sandbox denial); callers wrap
    // this in a try/catch and fall back rather than crashing a screen.
    let opened: preferences.Preferences;
    try {
      opened = preferences.getPreferencesSync(context, { name: name });
    } catch (error) {
      throw new Error(
        `Could not open preference store ${name}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
    AAPreferences.stores.set(name, opened);
    return opened;
  }
}

/**
 * Typed accessors over one named store.
 *
 * Reads are synchronous because the whole client assumes that; writes update the
 * in-memory store synchronously and flush in the background, so a crash can lose
 * the most recent write exactly as an unflushed Android `apply()` can.
 *
 * Every preferences call can throw (a corrupt store, a full disk, a closed
 * handle). Android's `SharedPreferences` calls are effectively infallible, so
 * each one is wrapped here and degrades to the fallback instead of taking a
 * screen down with it.
 */
export class AAPreferenceStore {
  private readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  private store(): preferences.Preferences | null {
    try {
      return AAPreferences.store(this.name);
    } catch (error) {
      AALog.error(`Failed to open preference store ${this.name}: ${errorMessage(error)}`);
      return null;
    }
  }

  getString(key: string, fallback: string): string {
    const store: preferences.Preferences | null = this.store();
    if (store === null) {
      return fallback;
    }
    try {
      const raw: preferences.ValueType = store.getSync(key, fallback);
      return typeof raw === 'string' ? raw : fallback;
    } catch (error) {
      AALog.error(`Failed to read ${this.name}.${key}: ${errorMessage(error)}`);
      return fallback;
    }
  }

  setString(key: string, value: string): void {
    this.put(key, value);
  }

  getBoolean(key: string, fallback: boolean): boolean {
    const store: preferences.Preferences | null = this.store();
    if (store === null) {
      return fallback;
    }
    try {
      const raw: preferences.ValueType = store.getSync(key, fallback);
      return typeof raw === 'boolean' ? raw : fallback;
    } catch (error) {
      AALog.error(`Failed to read ${this.name}.${key}: ${errorMessage(error)}`);
      return fallback;
    }
  }

  setBoolean(key: string, value: boolean): void {
    this.put(key, value);
  }

  getNumber(key: string, fallback: number): number {
    const store: preferences.Preferences | null = this.store();
    if (store === null) {
      return fallback;
    }
    try {
      const raw: preferences.ValueType = store.getSync(key, fallback);
      return typeof raw === 'number' ? raw : fallback;
    } catch (error) {
      AALog.error(`Failed to read ${this.name}.${key}: ${errorMessage(error)}`);
      return fallback;
    }
  }

  setNumber(key: string, value: number): void {
    this.put(key, value);
  }

  /**
   * Reads a string list.
   *
   * Used where Android stores a `StringSet`; preferences supports `Array<string>`
   * directly, so no JSON round-trip is needed.
   */
  getStringArray(key: string): string[] {
    const store: preferences.Preferences | null = this.store();
    if (store === null) {
      return [];
    }
    try {
      const raw: preferences.ValueType = store.getSync(key, []);
      if (!Array.isArray(raw)) {
        return [];
      }
      const out: string[] = [];
      for (const entry of raw as string[]) {
        if (typeof entry === 'string') {
          out.push(entry);
        }
      }
      return out;
    } catch (error) {
      AALog.error(`Failed to read ${this.name}.${key}: ${errorMessage(error)}`);
      return [];
    }
  }

  setStringArray(key: string, value: string[]): void {
    this.put(key, value);
  }

  has(key: string): boolean {
    const store: preferences.Preferences | null = this.store();
    if (store === null) {
      return false;
    }
    try {
      return store.hasSync(key);
    } catch (error) {
      AALog.error(`Failed to test ${this.name}.${key}: ${errorMessage(error)}`);
      return false;
    }
  }

  delete(key: string): void {
    const store: preferences.Preferences | null = this.store();
    if (store === null) {
      return;
    }
    try {
      store.deleteSync(key);
      this.flush(store);
    } catch (error) {
      AALog.error(`Failed to delete ${this.name}.${key}: ${errorMessage(error)}`);
    }
  }

  /** Removes every key, matching Android's `SharedPreferences.clear()`. */
  clear(): void {
    const store: preferences.Preferences | null = this.store();
    if (store === null) {
      return;
    }
    try {
      store.clearSync();
      this.flush(store);
    } catch (error) {
      AALog.error(`Failed to clear ${this.name}: ${errorMessage(error)}`);
    }
  }

  private put(key: string, value: preferences.ValueType): void {
    const store: preferences.Preferences | null = this.store();
    if (store === null) {
      return;
    }
    try {
      store.putSync(key, value);
      this.flush(store);
    } catch (error) {
      AALog.error(`Failed to write ${this.name}.${key}: ${errorMessage(error)}`);
    }
  }

  /**
   * Flushes off the caller's thread. A failed flush is logged but never thrown:
   * Android's `apply()` has the same best-effort semantics, and a persistence
   * failure must not take down a screen.
   */
  private flush(store: preferences.Preferences): void {
    store.flush().catch((error: Error) => {
      AALog.error(`Failed to flush preference store ${this.name}: ${error.message}`);
    });
  }
}

function errorMessage(error: Object): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}
