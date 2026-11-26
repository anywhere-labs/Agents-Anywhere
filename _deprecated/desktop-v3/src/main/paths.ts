// Where things live, in development (`desktop-v3/` checkout) and in a packaged app.

import { app } from "electron";
import * as path from "node:path";

export function appRoot(): string {
  return app.getAppPath();
}

/** The web-v3 static export (`yarn build:web` → `build/web`). */
export function webRoot(): string {
  return process.env.AA_DESKTOP_WEB_DIR || path.join(appRoot(), "build", "web");
}

/** The bundled connector-v3 entry (`yarn build:connector` → `build/connector`, `Resources/connector` when packaged). */
export function connectorEntry(): string {
  if (process.env.AA_DESKTOP_CONNECTOR_ENTRY) return process.env.AA_DESKTOP_CONNECTOR_ENTRY;
  const base = app.isPackaged ? path.join(process.resourcesPath, "connector") : path.join(appRoot(), "build", "connector");
  return path.join(base, "desktop-entry.mjs");
}

/** The managed connector's state directory (identity, settings, sessions). */
export function connectorDataDir(): string {
  return process.env.AA_DESKTOP_CONNECTOR_DATA_DIR || path.join(app.getPath("userData"), "connector-v3");
}

export function logDir(): string {
  return path.join(app.getPath("userData"), "logs");
}

export function iconPath(): string {
  return path.join(appRoot(), "resources", "icon.png");
}

export function configPath(): string {
  return path.join(appRoot(), "config.json");
}
