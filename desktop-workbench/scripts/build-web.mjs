import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererPackage = "agents-anywhere-desktop-renderer";
const yarnCommand = process.platform === "win32" ? "yarn.cmd" : "yarn";
const desktopConfig = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const apiOrigin = process.env.WORKBENCH_API_ORIGIN?.trim() || process.env.AGENTS_ANYWHERE_API?.trim() || desktopConfig.cloud.serverUrl;
const apiNamespace = process.env.WORKBENCH_API_NAMESPACE ?? process.env.AGENTS_ANYWHERE_API_NAMESPACE ?? desktopConfig.apiNamespace;

const build = spawn(yarnCommand, ["workspace", rendererPackage, "build"], {
  cwd: root,
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
