import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.resolve(root, "..", "web-next");
const yarnCommand = process.platform === "win32" ? "yarn.cmd" : "yarn";
const apiOrigin = process.env.WORKBENCH_API_ORIGIN?.trim() || process.env.AGENTS_ANYWHERE_API?.trim() || "https://web.agents-anywhere.com";
const apiNamespace = process.env.WORKBENCH_API_NAMESPACE ?? process.env.AGENTS_ANYWHERE_API_NAMESPACE ?? "";

const build = spawn(yarnCommand, ["build"], {
  cwd: webRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    AGENTS_ANYWHERE_API: apiOrigin,
    AGENTS_ANYWHERE_API_NAMESPACE: apiNamespace,
    NEXT_OUTPUT: "export",
  },
});

build.on("exit", (code) => {
  process.exit(code ?? 0);
});
