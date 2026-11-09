import type { DesktopSettings, DesktopSettingsPatch } from "./connector-types";
import { readJsonFile, writeJsonFile } from "./json-store";

export const NPMMIRROR_PYTHON_BUILDS = "https://registry.npmmirror.com/-/binary/python-build-standalone";

const DEFAULT_SETTINGS: DesktopSettings = {
  openAtLogin: false,
  startConnectorOnLaunch: true,
  silentLaunch: true,
  notificationsEnabled: true,
  confirmQuitOnShutdown: false,
  uvPath: "",
  pythonPath: "",
  uvPypiIndexUrl: "",
  uvPythonInstallMirror: "",
  connectorProxy: "",
  logChunkSizeKb: 512,
  logRetainChunks: 20,
  logRetentionDays: 14,
};

export class DesktopSettingsStore {
  private settings: DesktopSettings;

  constructor(private readonly filePath: string, systemLanguages: readonly string[] = []) {
    const saved = readJsonFile<Partial<DesktopSettings>>(filePath, {});
    this.settings = normalizeSettings(saved);
    // Decide before the first uv process, including provisioning before login.
    // A saved empty string is an explicit choice of the official source.
    const chinese = systemLanguages.some(language => /^zh(?:[-_]|$)/i.test(language.trim()));
    if (saved.uvPypiIndexUrl === undefined) {
      this.settings.uvPypiIndexUrl = chinese ? "https://mirrors.aliyun.com/pypi/simple" : "";
    }
    if (saved.uvPythonInstallMirror === undefined) {
      this.settings.uvPythonInstallMirror = chinese ? NPMMIRROR_PYTHON_BUILDS : "";
    }
    if (saved.uvPypiIndexUrl === undefined || saved.uvPythonInstallMirror === undefined) {
      writeJsonFile(this.filePath, this.settings);
    }
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
    uvPath: typeof value.uvPath === "string" ? value.uvPath.trim() : DEFAULT_SETTINGS.uvPath,
    pythonPath: typeof value.pythonPath === "string" ? value.pythonPath.trim() : DEFAULT_SETTINGS.pythonPath,
    uvPypiIndexUrl: typeof value.uvPypiIndexUrl === "string"
      ? value.uvPypiIndexUrl.trim()
      : DEFAULT_SETTINGS.uvPypiIndexUrl,
    uvPythonInstallMirror: typeof value.uvPythonInstallMirror === "string"
      ? value.uvPythonInstallMirror.trim()
      : DEFAULT_SETTINGS.uvPythonInstallMirror,
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
