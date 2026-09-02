import { execFile } from "node:child_process";
import os from "node:os";

const NAME_TIMEOUT_MS = 1_500;

export async function systemDeviceName(): Promise<string> {
  if (process.platform === "darwin") {
    const computerName = await commandOutput("/usr/sbin/scutil", ["--get", "ComputerName"]);
    if (computerName) return computerName;
  }
  if (process.platform === "win32") {
    const computerName = process.env.COMPUTERNAME?.trim();
    if (computerName) return computerName;
  }
  return os.hostname().trim() || "Desktop";
}

function commandOutput(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      { encoding: "utf8", timeout: NAME_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? "" : stdout.trim()),
    );
  });
}
