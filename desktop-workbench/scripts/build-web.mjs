import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.resolve(root, "..", "web-next");
const yarnCommand = process.platform === "win32" ? "yarn.cmd" : "yarn";

const build = spawn(yarnCommand, ["build"], {
  cwd: webRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    NEXT_OUTPUT: "export",
  },
});

build.on("exit", (code) => {
  process.exit(code ?? 0);
});

