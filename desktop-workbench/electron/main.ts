import { app, BrowserWindow, ipcMain, net, protocol, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const APP_NAME = "Agents Anywhere Workbench";
const WEB_PROTOCOL = "aa-workbench";
const WEB_HOST = "web";
const DEFAULT_API_ORIGIN = "https://web.agents-anywhere.com";
const DEFAULT_API_NAMESPACE = "/api/v2";
const API_ROUTE_PREFIXES = [
  "/admin",
  "/agents",
  "/auth",
  "/connector",
  "/connectors",
  "/health",
  "/oauth",
  "/pairing",
  "/sessions",
  "/.well-known",
];

let mainWindow: BrowserWindow | null = null;
let devOrigin: string | null = null;

app.setName(APP_NAME);

protocol.registerSchemesAsPrivileged([
  {
    scheme: WEB_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function webOutDir() {
  if (process.env.WORKBENCH_WEB_OUT_DIR?.trim()) {
    return path.resolve(process.env.WORKBENCH_WEB_OUT_DIR.trim());
  }
  return path.resolve(app.getAppPath(), "renderer", "out");
}

function staticWorkbenchUrl(route = "/") {
  return `${WEB_PROTOCOL}://${WEB_HOST}${route}`;
}

function apiOrigin() {
  return (process.env.WORKBENCH_API_ORIGIN || process.env.AGENTS_ANYWHERE_API || DEFAULT_API_ORIGIN).replace(/\/+$/, "");
}

function apiNamespace() {
  const namespace = process.env.WORKBENCH_API_NAMESPACE ?? process.env.AGENTS_ANYWHERE_API_NAMESPACE ?? DEFAULT_API_NAMESPACE;
  return normalizeApiNamespace(namespace);
}

function normalizeApiNamespace(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function shouldProxyApiPath(pathname: string) {
  const namespace = apiNamespace();
  if (namespace) return pathname === namespace || pathname.startsWith(`${namespace}/`);
  return API_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function registerStaticWebProtocol() {
  protocol.handle(WEB_PROTOCOL, (request) => {
    const url = new URL(request.url);
    if (url.hostname !== WEB_HOST) {
      return new Response("Not found", { status: 404 });
    }

    if (shouldProxyApiPath(url.pathname)) {
      return net.fetch(`${apiOrigin()}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    }

    const outDir = webOutDir();
    const filePath = resolveStaticFile(outDir, url.pathname);
    if (filePath) {
      return net.fetch(pathToFileURL(filePath).toString());
    }

    if (!fs.existsSync(outDir)) {
      return new Response(missingWebBuildHtml(outDir), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  });
}

function resolveStaticFile(outDir: string, pathname: string) {
  const rawPath = decodeURIComponent(pathname);
  const relativePath = rawPath === "/" ? "index.html" : rawPath.replace(/^\/+/, "");
  const candidates = [
    path.resolve(outDir, relativePath),
    path.resolve(outDir, relativePath, "index.html"),
    path.resolve(outDir, `${relativePath}.html`),
  ];

  for (const candidate of candidates) {
    if (!isInside(candidate, outDir)) continue;
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try the next static-export candidate.
    }
  }
  return null;
}

function isInside(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function missingWebBuildHtml(outDir: string) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${APP_NAME}</title>
    <style>
      html, body {
        margin: 0;
        height: 100%;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #0a0a0b;
        color: #f4f4f5;
      }
      body {
        display: grid;
        place-items: center;
      }
      main {
        width: min(560px, calc(100vw - 48px));
        line-height: 1.5;
      }
      code {
        border: 1px solid #333;
        border-radius: 6px;
        background: #171717;
        padding: 2px 6px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Web workbench build not found</h1>
      <p>Build the web app first, then start this Electron shell.</p>
      <p><code>yarn build:web</code></p>
      <p>Expected output directory: <code>${escapeHtml(outDir)}</code></p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function createMainWindow() {
  const devUrl = process.env.WORKBENCH_WEB_URL?.trim();
  devOrigin = devUrl ? new URL(devUrl).origin : null;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: APP_NAME,
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    trafficLightPosition: process.platform === "darwin" ? { x: 17, y: 16 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isWorkbenchUrl(url)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isWorkbenchUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  void mainWindow.loadURL(devUrl || staticWorkbenchUrl("/"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function isWorkbenchUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === `${WEB_PROTOCOL}:` && url.hostname === WEB_HOST) return true;
    if (devOrigin && url.origin === devOrigin) return true;
  } catch {
    return false;
  }
  return false;
}

ipcMain.handle("workbench:openExternal", async (_event, url: string) => {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Only http(s) URLs can be opened externally.");
  }
  await shell.openExternal(url);
});

app.whenReady().then(() => {
  registerStaticWebProtocol();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
