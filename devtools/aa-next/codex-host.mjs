import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

function requiredPath(name) {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

async function run() {
  const adapter = requiredPath("AA_NEXT_CODEX_ACP_BUILD");
  const expected = process.env.AA_NEXT_CODEX_ACP_SHA256;
  const actual = createHash("sha256").update(await readFile(adapter)).digest("hex");
  if (actual !== expected) throw new Error("AA_NEXT_CODEX_ACP_SHA256 does not match the adapter build");
  const entry = requiredPath("AA_NEXT_CONVERSATION_HOST");
  const { openLocalConversationHost } = await import(pathToFileURL(entry).href);
  const codexDir = process.env.CODEX_HOME || join(homedir(), ".codex");
  const { manager, close } = await openLocalConversationHost({
    stateDir: process.env.AA_NEXT_STATE_DIR || join(homedir(), ".agents-anywhere", "aa-next-codex"),
    codexCommand: [process.execPath, adapter],
    codexIpcSocket: process.env.CODEX_ACP_IPC_SOCKET || (process.platform === "win32"
      ? "\\\\.\\pipe\\codex-ipc"
      : join(codexDir, "ipc", "ipc.sock")),
  });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const watches = new Map();
  const output = value => process.stdout.write(JSON.stringify(value) + "\n");
  const caller = { principal: "local" };
  const onInterrupt = () => input.close();
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  output({ ready: true });
  try {
    for await (const line of input) {
      try {
        const { command, id, text, clientMessageId, delivery = "auto" } = JSON.parse(line);
        if (command !== "list" && (typeof id !== "string" || id === "")) throw new Error("A conversation id is required");
        switch (command) {
          case "list":
            await manager.cli.refresh();
            output({ command, result: manager.listing() });
            break;
          case "follow":
            output({ command, result: await manager.adopt(id, caller) });
            break;
          case "watch": {
            if (watches.has(id)) break;
            const controller = new AbortController();
            const task = (async () => {
              for await (const event of manager.watch(id, controller.signal)) output({ id, event });
            })().catch(error => {
              output({ id, error: error.message });
            }).finally(() => watches.delete(id));
            watches.set(id, { controller, task });
            break;
          }
          case "unwatch":
            watches.get(id)?.controller.abort();
            break;
          case "send":
            if (typeof text !== "string" || typeof clientMessageId !== "string" || !clientMessageId
                || !["auto", "steer", "queue"].includes(delivery)) throw new Error("Invalid send arguments");
            output({ command, result: await manager.send(id, clientMessageId, text, caller, delivery) });
            break;
          case "stop":
            await manager.get(id).stop();
            output({ command, result: {} });
            break;
          default:
            throw new Error("Unknown command");
        }
      } catch (error) {
        output({ error: error.message, code: error.code });
      }
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
    const active = [...watches.values()];
    active.forEach(({ controller }) => controller.abort());
    await Promise.all(active.map(({ task }) => task));
    await close();
  }
}

run().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
