// GUI apps on macOS / Linux start with a minimal PATH. Agents (claude, codex, agy, pi, npx …) are usually
// installed through the user's shell profile (nvm, ~/.local/bin, Homebrew), so the managed connector gets the
// environment of a login shell.

import { spawn } from "node:child_process";

const TIMEOUT_MS = 5_000;
const MARKER = "__AA_DESKTOP_ENV__";

export function parseEnvOutput(output: string): NodeJS.ProcessEnv {
  const start = output.indexOf(MARKER);
  const body = start >= 0 ? output.slice(start + MARKER.length) : output;
  const env: NodeJS.ProcessEnv = {};
  for (const entry of body.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq).replace(/^\n+/u, "")] = entry.slice(eq + 1);
  }
  return env;
}

function readFrom(shell: string): Promise<NodeJS.ProcessEnv | null> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (value: NodeJS.ProcessEnv | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // `env -0` keeps values with newlines intact; the marker skips anything the profile prints first.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(shell, ["-ilc", `printf '%s' '${MARKER}'; env -0`], {
      stdio: ["ignore", "pipe", "ignore"],
      env,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("error", () => finish(null));
    child.on("exit", (code) => {
      if (code !== 0 || !output.includes(MARKER)) return finish(null);
      const env = parseEnvOutput(output);
      finish(Object.keys(env).length > 0 ? env : null);
    });
  });
}

/** The login shell's environment merged over ours (ours wins for anything the app set explicitly). */
export async function loginShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (process.platform === "win32") return { ...process.env };
  for (const shell of [process.env.SHELL, "/bin/zsh", "/bin/bash"]) {
    if (!shell) continue;
    const env = await readFrom(shell);
    if (env) {
      const merged = { ...env, ...process.env };
      if (env.PATH) merged.PATH = env.PATH;
      return merged;
    }
  }
  return { ...process.env };
}
