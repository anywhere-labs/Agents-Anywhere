import { BrowserWindow } from "electron";
import { DESKTOP_OAUTH_PROTOCOL } from "./desktop-oauth";

const APP_NAME = "Agents Anywhere";

let developmentLoginWindow: BrowserWindow | null = null;

type DevelopmentLoginOptions = {
  parent: BrowserWindow | null;
  authorizeUrl: string;
  onCallback: (url: string) => void;
};

export async function openDevelopmentLoginWindow(
  options: DevelopmentLoginOptions,
): Promise<string> {
  const loginUrl = options.authorizeUrl;
  if (!isHttpUrl(loginUrl)) throw new Error("Invalid development OAuth URL.");
  const existing = developmentLoginWindow;
  if (existing && !existing.isDestroyed()) {
    existing.destroy();
  }

  const window = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 420,
    minHeight: 560,
    show: false,
    parent: options.parent && !options.parent.isDestroyed() ? options.parent : undefined,
    title: APP_NAME,
    autoHideMenuBar: true,
    backgroundColor: "#09090b",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  developmentLoginWindow = window;

  let settled = false;
  const acceptCallback = (url: string): boolean => {
    if (!url.startsWith(`${DESKTOP_OAUTH_PROTOCOL}:`)) return false;
    if (!settled) {
      settled = true;
      options.onCallback(url);
      window.close();
    }
    return true;
  };

  window.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(APP_NAME);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!acceptCallback(url) && isHttpUrl(url)) void window.loadURL(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isHttpUrl(url)) event.preventDefault();
    acceptCallback(url);
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isHttpUrl(url)) event.preventDefault();
    acceptCallback(url);
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (developmentLoginWindow === window) developmentLoginWindow = null;
  });

  try {
    await window.loadURL(loginUrl);
  } catch (error) {
    if (settled) return loginUrl;
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
  return loginUrl;
}

function isHttpUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}
