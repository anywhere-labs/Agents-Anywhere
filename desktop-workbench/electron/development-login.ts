import { BrowserWindow } from "electron";

const SESSION_KEY = "aa.session.v1";
const APP_NAME = "Agents Anywhere";

let developmentLoginWindow: BrowserWindow | null = null;

type DevelopmentLoginOptions = {
  parent: BrowserWindow | null;
  webOrigin: string;
  onAccessToken: (accessToken: string) => void;
};

export async function openDevelopmentLoginWindow(
  options: DevelopmentLoginOptions,
): Promise<string> {
  const webOrigin = normalizeWebOrigin(options.webOrigin);
  const loginUrl = `${webOrigin}/#/login`;
  const existing = developmentLoginWindow;
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return loginUrl;
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
  let checking = false;
  const checkForSession = async () => {
    if (settled || checking || window.isDestroyed()) return;
    if (!isSameOrigin(window.webContents.getURL(), webOrigin)) return;
    checking = true;
    try {
      const rawSession = await window.webContents.executeJavaScript(
        `window.localStorage.getItem(${JSON.stringify(SESSION_KEY)})`,
        true,
      ) as unknown;
      const accessToken = accessTokenFromStoredSession(rawSession);
      if (!accessToken || settled) return;
      settled = true;
      options.onAccessToken(accessToken);
      window.close();
    } catch {
      // Navigation may replace the page while a session check is running.
    } finally {
      checking = false;
    }
  };

  const checkTimer = setInterval(() => void checkForSession(), 500);
  window.webContents.on("did-finish-load", () => void checkForSession());
  window.webContents.on("did-navigate-in-page", () => void checkForSession());
  window.webContents.on("did-navigate", () => void checkForSession());
  window.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(APP_NAME);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void window.loadURL(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isHttpUrl(url)) return;
    event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    clearInterval(checkTimer);
    if (developmentLoginWindow === window) developmentLoginWindow = null;
  });

  try {
    await window.loadURL(loginUrl);
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
  return loginUrl;
}

function accessTokenFromStoredSession(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const session = JSON.parse(value) as { accessToken?: unknown };
    return typeof session.accessToken === "string" && session.accessToken
      ? session.accessToken
      : null;
  } catch {
    return null;
  }
}

function normalizeWebOrigin(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("Development login Web origin must be an http(s) URL without credentials.");
  }
  return url.origin;
}

function isSameOrigin(value: string, origin: string): boolean {
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}
