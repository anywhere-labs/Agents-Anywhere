import type {
  ConnectorPrivateConfig,
  LocalDesktopBinding,
  PublicLocalDesktopBinding,
} from "./connector-types";
import { readJsonFile, removeFile, writeJsonFile } from "./json-store";

export class DesktopBindingStore {
  private binding: LocalDesktopBinding | null;

  constructor(private readonly filePath: string) {
    this.binding = normalizeBinding(readJsonFile<unknown>(filePath, null));
  }

  get(): LocalDesktopBinding | null {
    return this.binding ? { ...this.binding } : null;
  }

  getPublic(hasCredential: boolean): PublicLocalDesktopBinding | null {
    return this.binding ? { ...this.binding, hasCredential } : null;
  }

  save(binding: LocalDesktopBinding): LocalDesktopBinding {
    const next = { ...binding };
    writeJsonFile(this.filePath, next);
    this.binding = next;
    return this.get()!;
  }

  updateName(name: string): LocalDesktopBinding {
    if (!this.binding) throw new Error("This Desktop does not have a local device binding.");
    const normalized = name.trim();
    if (!normalized) throw new Error("Device name cannot be empty.");
    return this.save({ ...this.binding, name: normalized });
  }

  clear(): void {
    this.binding = null;
    removeFile(this.filePath);
  }

  adoptConfig(config: ConnectorPrivateConfig, name = ""): LocalDesktopBinding {
    if (this.binding?.connectorId === config.connectorId) return this.get()!;
    return this.save({
      connectorId: config.connectorId,
      serverUrl: config.serverUrl,
      name,
      ownerUserId: "",
      manualDisconnected: false,
    });
  }
}

function normalizeBinding(value: unknown): LocalDesktopBinding | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<LocalDesktopBinding>;
  if (
    typeof candidate.connectorId !== "string" ||
    !candidate.connectorId.trim() ||
    typeof candidate.serverUrl !== "string" ||
    !candidate.serverUrl.trim()
  ) {
    return null;
  }
  return {
    connectorId: candidate.connectorId.trim(),
    serverUrl: candidate.serverUrl.trim().replace(/\/+$/, ""),
    name: typeof candidate.name === "string" ? candidate.name : "",
    ownerUserId: typeof candidate.ownerUserId === "string" ? candidate.ownerUserId : "",
    manualDisconnected: Boolean(candidate.manualDisconnected),
  };
}
