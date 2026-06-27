import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name) => path.join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
const usesShell = process.platform === "win32";
const devUrl = "http://127.0.0.1:5184";

const next = spawn(bin("next"), ["dev", "--hostname", "127.0.0.1", "--port", "5184"], {
  cwd: root,
  stdio: "inherit",
  shell: usesShell,
});

async function waitForNext() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await canReach(devUrl)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Next dev server did not start on ${devUrl}`);
}

function canReach(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(700, () => {
      req.destroy();
      resolve(false);
    });
  });
}

try {
  await waitForNext();
  const electron = spawn(bin("electron"), ["."], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      NEXT_DEV_SERVER_URL: devUrl,
    },
    shell: usesShell,
  });
  electron.on("exit", (code) => {
    next.kill();
    process.exit(code ?? 0);
  });
} catch (error) {
  console.error(error);
  next.kill();
  process.exit(1);
}
