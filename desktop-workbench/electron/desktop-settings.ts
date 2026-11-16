import type { DesktopSettings, DesktopSettingsPatch } from "./connector-types";
import { readJsonFile, writeJsonFile } from "./json-store";

const DEFAULT_SETTINGS: DesktopSettings = {
  openAtLogin: false,
  startConnectorOnLaunch: true,
  silentLaunch: true,
  notificationsEnabled: true,
  confirmQuitOnShutdown: false,
  connectorProxy: "",
  logChunkSizeKb: 512,
  logRetainChunks: 20,
  logRetentionDays: 14,
};

export class DesktopSettingsStore {
  private settings: DesktopSettings;

  /**
   * Settings of the Python Connector Desktop no longer runs (uv, Python and
   * package mirrors) are ignored and dropped on the next write.
   */
  constructor(private readonly filePath: string, _systemLanguages: readonly string[] = []) {
    this.settings = normalizeSettings(readJsonFile<Partial<DesktopSettings>>(filePath, {}));
  }

  get(): DesktopSettings {
    return { ...this.settings };
  }

  save(patch: DesktopSettingsPatch): DesktopSettings {
    // The device setting is not a local preference; only the Connector sets it.
    const { confirmQuitOnShutdown: _ignored, ...local } = patch as Partial<DesktopSettings>;
    return this.write({ ...this.settings, ...local });
  }

  /** Records the device settings the server handed over; returns whether they changed. */
  saveDeviceSettings(settings: { confirmQuitOnShutdown: boolean }): boolean {
    if (this.settings.confirmQuitOnShutdown === settings.confirmQuitOnShutdown) return false;
    this.write({ ...this.settings, confirmQuitOnShutdown: settings.confirmQuitOnShutdown });
    return true;
  }

  private write(value: Partial<DesktopSettings>): DesktopSettings {
    const next = normalizeSettings(value);
    writeJsonFile(this.filePath, next);
    this.settings = next;
    return this.get();
  }
}

/** Read-only view for Main, which must not initialize the backend's settings file. */
export function readDesktopSettings(filePath: string): DesktopSettings {
  return normalizeSettings(readJsonFile<Partial<DesktopSettings>>(filePath, {}));
}

function normalizeSettings(value: Partial<DesktopSettings>): DesktopSettings {
  return {
    openAtLogin: booleanValue(value.openAtLogin, DEFAULT_SETTINGS.openAtLogin),
    startConnectorOnLaunch: booleanValue(
      value.startConnectorOnLaunch,
      DEFAULT_SETTINGS.startConnectorOnLaunch,
    ),
    silentLaunch: booleanValue(value.silentLaunch, DEFAULT_SETTINGS.silentLaunch),
    notificationsEnabled: booleanValue(
      value.notificationsEnabled,
      DEFAULT_SETTINGS.notificationsEnabled,
    ),
    confirmQuitOnShutdown: booleanValue(
      value.confirmQuitOnShutdown,
      DEFAULT_SETTINGS.confirmQuitOnShutdown,
    ),
    connectorProxy: connectorProxyValue(value.connectorProxy),
    logChunkSizeKb: clamp(value.logChunkSizeKb, DEFAULT_SETTINGS.logChunkSizeKb, 64, 10_240),
    logRetainChunks: clamp(value.logRetainChunks, DEFAULT_SETTINGS.logRetainChunks, 1, 200),
    logRetentionDays: clamp(value.logRetentionDays, DEFAULT_SETTINGS.logRetentionDays, 1, 365),
  };
}

/** An unusable value follows the system rather than handing the Connector a bad URL. */
function connectorProxyValue(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "direct") return text;
  return /^(?:https?|socks5h?):\/\/[^\s/]+/i.test(text) ? text : DEFAULT_SETTINGS.connectorProxy;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clamp(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}
