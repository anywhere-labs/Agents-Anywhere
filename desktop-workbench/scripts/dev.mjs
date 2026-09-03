import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererPackage = "agents-anywhere-desktop-renderer";
const explicitWebUrl = process.env.WORKBENCH_WEB_URL?.trim();
const explicitWebPort = parsePort(process.env.WORKBENCH_WEB_PORT);
const apiOrigin = process.env.WORKBENCH_API_ORIGIN?.trim() || process.env.AGENTS_ANYWHERE_API?.trim() || "https://web.agents-anywhere.com";
const apiNamespace = process.env.WORKBENCH_API_NAMESPACE ?? process.env.AGENTS_ANYWHERE_API_NAMESPACE ?? "/api/v2";
const usesShell = process.platform === "win32";
const host = "127.0.0.1";
const yarnCommand = process.platform === "win32" ? "yarn.cmd" : "yarn";

let webProcess = null;
let devUrl = explicitWebUrl;

if (!explicitWebUrl) {
  const port = explicitWebPort ?? await findAvailablePort(5184);
  devUrl = `http://${host}:${port}`;
  console.log(`Starting desktop renderer at ${devUrl}`);
  console.log(`Using Agents Anywhere API at ${apiOrigin}${apiNamespace || ""}`);
  webProcess = spawn(yarnCommand, ["workspace", rendererPackage, "exec", "next", "dev", "--hostname", host, "--port", String(port)], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      AGENTS_ANYWHERE_API: apiOrigin,
      AGENTS_ANYWHERE_API_NAMESPACE: apiNamespace,
    },
    shell: usesShell,
  });
} else {
  console.log(`Using existing web app at ${devUrl}`);
}

try {
  await waitForUrl(devUrl);
  const electronProcess = spawn(path.join(root, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron"), ["."], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      WORKBENCH_WEB_URL: devUrl,
    },
    shell: usesShell,
  });

  const shutdown = () => {
    webProcess?.kill();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  electronProcess.on("exit", (code) => {
    shutdown();
    process.exit(code ?? 0);
  });
} catch (error) {
  console.error(error);
  webProcess?.kill();
  process.exit(1);
}

function parsePort(value) {
  if (value == null || value.trim() === "") return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid WORKBENCH_WEB_PORT: ${value}`);
  }
  return port;
}

function findAvailablePort(startPort) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const server = net.createServer();
      server.once("error", (error) => {
        if (error && error.code === "EADDRINUSE") {
          tryPort(port + 1);
          return;
        }
        reject(error);
      });
      server.once("listening", () => {
        server.close(() => resolve(port));
      });
      server.listen(port, host);
    };
    tryPort(startPort);
  });
}

function waitForUrl(url) {
  const deadline = Date.now() + 45_000;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await canReach(url)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Web app did not become reachable at ${url}`));
        return;
      }
      setTimeout(tick, 300);
    };
    void tick();
  });
}

function canReach(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve((response.statusCode ?? 500) < 500);
    });
    request.on("error", () => resolve(false));
    request.setTimeout(700, () => {
      request.destroy();
      resolve(false);
    });
  });
}
