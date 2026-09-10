import type { DesktopSettings, DesktopSettingsPatch } from "./connector-types";
import { readJsonFile, writeJsonFile } from "./json-store";

const DEFAULT_SETTINGS: DesktopSettings = {
  openAtLogin: false,
  startConnectorOnLaunch: true,
  silentLaunch: true,
  notificationsEnabled: true,
  uvPath: "",
  uvPypiIndexUrl: "",
  logChunkSizeKb: 512,
  logRetainChunks: 20,
  logRetentionDays: 14,
};

export class DesktopSettingsStore {
  private settings: DesktopSettings;

  constructor(private readonly filePath: string, systemLanguages: readonly string[] = []) {
    const saved = readJsonFile<Partial<DesktopSettings>>(filePath, {});
    this.settings = normalizeSettings(saved);
    if (saved.uvPypiIndexUrl === undefined) {
      // Decide before the first uv process, including provisioning before login.
      // A saved empty string is an explicit choice of the official index.
      this.settings.uvPypiIndexUrl = systemLanguages.some(language => /^zh(?:[-_]|$)/i.test(language.trim()))
        ? "https://mirrors.aliyun.com/pypi/simple" : "";
      writeJsonFile(this.filePath, this.settings);
    }
  }

  get(): DesktopSettings {
    return { ...this.settings };
  }

  save(patch: DesktopSettingsPatch): DesktopSettings {
    const next = normalizeSettings({ ...this.settings, ...patch });
    writeJsonFile(this.filePath, next);
    this.settings = next;
    return this.get();
  }
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
    uvPath: typeof value.uvPath === "string" ? value.uvPath.trim() : DEFAULT_SETTINGS.uvPath,
    uvPypiIndexUrl: typeof value.uvPypiIndexUrl === "string"
      ? value.uvPypiIndexUrl.trim()
      : DEFAULT_SETTINGS.uvPypiIndexUrl,
    logChunkSizeKb: clamp(value.logChunkSizeKb, DEFAULT_SETTINGS.logChunkSizeKb, 64, 10_240),
    logRetainChunks: clamp(value.logRetainChunks, DEFAULT_SETTINGS.logRetainChunks, 1, 200),
    logRetentionDays: clamp(value.logRetentionDays, DEFAULT_SETTINGS.logRetentionDays, 1, 365),
  };
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clamp(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}
