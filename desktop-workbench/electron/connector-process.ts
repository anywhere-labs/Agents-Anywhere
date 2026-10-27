import { spawn, type ChildProcess } from "node:child_process";

/** Kill descendants as well, even if the group leader has already exited. */
export async function terminateConnectorProcess(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", reject);
      killer.once("close", () => resolve());
    });
    return;
  }
  const signal = (value: NodeJS.Signals) => {
    try { process.kill(-child.pid!, value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  signal("SIGTERM");
  // Do not let the parent exiting early leave a child that ignores SIGTERM.
  await new Promise<void>(resolve => {
    const deadline = Date.now() + 2_000;
    const poll = () => {
      try { process.kill(-child.pid!, 0); }
      catch { resolve(); return; }
      if (Date.now() >= deadline) { signal("SIGKILL"); resolve(); return; }
      setTimeout(poll, 25);
    };
    poll();
  });
}
