import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(root, "..");
const webRoot = path.join(repoRoot, "web-next");
const explicitWebUrl = process.env.WORKBENCH_WEB_URL?.trim();
const apiOrigin = process.env.WORKBENCH_API_ORIGIN?.trim() || process.env.AGENTS_ANYWHERE_API?.trim() || "https://web.agents-anywhere.com";
const apiNamespace = process.env.WORKBENCH_API_NAMESPACE ?? process.env.AGENTS_ANYWHERE_API_NAMESPACE ?? "";
const usesShell = process.platform === "win32";
const host = "127.0.0.1";

let webProcess = null;
let devUrl = explicitWebUrl;

if (!explicitWebUrl) {
  const port = await findAvailablePort(5184);
  devUrl = `http://${host}:${port}`;
  const nextBin = path.join(webRoot, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");
  console.log(`Starting web-next at ${devUrl}`);
  console.log(`Using Agents Anywhere API at ${apiOrigin}${apiNamespace || ""}`);
  webProcess = spawn(nextBin, ["dev", "--hostname", host, "--port", String(port)], {
    cwd: webRoot,
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
