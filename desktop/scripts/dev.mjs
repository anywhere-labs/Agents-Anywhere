import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name) => path.join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
const usesShell = process.platform === "win32";
const vite = spawn(bin("vite"), [], { cwd: root, stdio: "inherit", shell: usesShell });

async function waitForVite() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await canReach("http://127.0.0.1:5183")) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Vite dev server did not start on http://127.0.0.1:5183");
}

function canReach(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

try {
  await waitForVite();
  const electron = spawn(bin("electron"), ["."], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5183",
    },
    shell: usesShell,
  });
  electron.on("exit", (code) => {
    vite.kill();
    process.exit(code ?? 0);
  });
} catch (error) {
  console.error(error);
  vite.kill();
  process.exit(1);
}
