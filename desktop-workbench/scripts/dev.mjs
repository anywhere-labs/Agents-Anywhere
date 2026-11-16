import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureFrpcBundle } from "./prepare-frpc.mjs";
import { ensureRouterBundle } from "./prepare-router.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererPackage = "agents-anywhere-desktop-renderer";
const explicitWebUrl = process.env.WORKBENCH_WEB_URL?.trim();
const explicitWebPort = parsePort(process.env.WORKBENCH_WEB_PORT);
const desktopConfig = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const apiOrigin = process.env.WORKBENCH_API_ORIGIN?.trim() || process.env.AGENTS_ANYWHERE_API?.trim() || desktopConfig.cloud.serverUrl;
const apiNamespace = process.env.WORKBENCH_API_NAMESPACE ?? process.env.AGENTS_ANYWHERE_API_NAMESPACE ?? desktopConfig.apiNamespace;
const usesShell = process.platform === "win32";
const host = "127.0.0.1";
const yarnCommand = process.platform === "win32" ? "yarn.cmd" : "yarn";

let webProcess = null;
let devUrl = explicitWebUrl;

// Development runs the same Connector bundle and Router the installer ships.
const connectorBundle = prepareConnector();

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
  await connectorBundle;
  // What electron.cmd does, minus cmd.exe: a shell would split a project path
  // that contains a space.
  const electronCli = createRequire(import.meta.url).resolve("electron/cli.js");
  const electronProcess = spawn(process.execPath, [electronCli, "."], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      WORKBENCH_WEB_URL: devUrl,
    },
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

/**
 * Builds the Router (once per MeshCall commit) and bundles the TS Connector
 * from `../connector-ts`. A failure is not fatal: Desktop starts and reports
 * the Connector as unavailable.
 */
async function prepareConnector() {
  try {
    const [routerPath] = await ensureRouterBundle({ log: (message) => console.log(message) });
    console.log(`Using meshcall-router at ${routerPath}`);
  } catch (error) {
    console.warn(`Could not build meshcall-router: ${error instanceof Error ? error.message : error}`);
    console.warn("Install Go, or set MESHCALL_ROUTER_BINARY to a router built from vendor/meshcall's commit.");
  }
  try {
    const [frpcPath] = await ensureFrpcBundle({ log: (message) => console.log(message) });
    console.log(`Using frpc at ${frpcPath}`);
  } catch (error) {
    console.warn(`Could not prepare frpc; port preview stays unavailable: ${error instanceof Error ? error.message : error}`);
  }
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "bundle-connector.mjs")], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) console.warn("Could not bundle the Connector; run `yarn bundle:connector` after installing connector-ts dependencies.");
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
