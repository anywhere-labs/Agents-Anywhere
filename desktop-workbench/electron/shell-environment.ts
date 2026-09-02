import { spawn } from "node:child_process";

const SNAPSHOT_TIMEOUT_MS = 3_500;

export async function readShellEnvironment(): Promise<NodeJS.ProcessEnv> {
  for (const [executable, args] of candidateCommands()) {
    const environment = await runEnvironmentCommand(executable, args);
    if (environment && Object.keys(environment).length > 0) return environment;
  }
  return {};
}

function candidateCommands(): Array<[string, string[]]> {
  if (process.platform === "win32") {
    return [[
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8; Get-ChildItem Env: | ConvertTo-Json -Compress",
      ],
    ]];
  }
  return [
    [process.env.SHELL || "/bin/zsh", ["-lic", "env"]],
    ["/bin/zsh", ["-lic", "env"]],
    ["/bin/bash", ["-lc", "env"]],
  ];
}

function runEnvironmentCommand(
  executable: string,
  args: string[],
): Promise<NodeJS.ProcessEnv | null> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    let settled = false;
    const finish = (value: NodeJS.ProcessEnv | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, SNAPSHOT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("exit", (code) => {
      if (code !== 0 || !output.trim()) return finish(null);
      finish(process.platform === "win32" ? parsePowerShell(output) : parseEnv(output));
    });
  });
}

function parseEnv(output: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const line of output.split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals > 0) result[line.slice(0, equals)] = line.slice(equals + 1);
  }
  return result;
}

function parsePowerShell(output: string): NodeJS.ProcessEnv {
  try {
    const parsed = JSON.parse(output) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const result: NodeJS.ProcessEnv = {};
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const candidate = row as { Name?: unknown; Value?: unknown };
      if (typeof candidate.Name === "string" && typeof candidate.Value === "string") {
        result[candidate.Name] = candidate.Value;
      }
    }
    return result;
  } catch {
    return {};
  }
}
