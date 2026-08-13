import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(root, "..");
const webRoot = path.join(repoRoot, "web-next");
const explicitWebUrl = process.env.WORKBENCH_WEB_URL?.trim();
const devUrl = explicitWebUrl || "http://127.0.0.1:5174";
const usesShell = process.platform === "win32";
const yarnCommand = process.platform === "win32" ? "yarn.cmd" : "yarn";

let webProcess = null;

if (!explicitWebUrl) {
  webProcess = spawn(yarnCommand, ["dev"], {
    cwd: webRoot,
    stdio: "inherit",
    shell: usesShell,
  });
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

