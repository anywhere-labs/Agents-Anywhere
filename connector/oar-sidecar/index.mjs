import { createInterface } from "node:readline";
import { defaultRuntimes } from "@botiverse/oar";

const sessions = new Map();
let commandQueue = Promise.resolve();
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const ok = (id, result = {}) => output({ id, ok: true, result });
const fail = (id, error) => output({ id, ok: false, error: String(error?.message ?? error) });

async function handle(message) {
  const { id, method, params = {} } = message;
  try {
    if (method === "discover") {
      const runtime = defaultRuntimes.require("pi");
      const installation = await runtime.installation?.();
      ok(id, { available: installation?.kind === "available", installation });
      return;
    }
    if (method === "start") {
      const runtime = defaultRuntimes.require("pi");
      const installation = await runtime.installation?.();
      if (installation?.kind !== "available") throw new Error("Pi is not installed");
      const session = await runtime.session(installation, {
        cwd: params.cwd,
        model: params.model,
        resume: params.resume,
      });
      session.events((event) => output({ type: "event", sessionId: params.sessionId, event }));
      sessions.set(params.sessionId, session);
      ok(id, { externalSessionId: session.id });
      return;
    }
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown Pi session: ${params.sessionId}`);
    if (method === "prompt") {
      const result = await session.prompt(params.content);
      ok(id, result ?? {});
    } else if (method === "deliver") {
      const result = await session.deliver(params.content);
      ok(id, result ?? {});
    } else if (method === "abort") {
      const result = await session.abort?.();
      ok(id, result ?? {});
    } else if (method === "dispose") {
      await session.dispose();
      sessions.delete(params.sessionId);
      ok(id);
    } else if (method === "status") {
      ok(id, { status: session.status?.().value, usage: session.usage?.().value });
    } else {
      throw new Error(`Unsupported method: ${method}`);
    }
  } catch (error) {
    fail(id, error);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch (error) { output({ ok: false, error: String(error) }); return; }
  commandQueue = commandQueue.then(() => handle(message)).catch((error) => {
    output({ id: message.id, ok: false, error: String(error?.message ?? error) });
  });
});
process.on("SIGTERM", async () => {
  await Promise.all([...sessions.values()].map((session) => session.dispose().catch(() => {})));
  process.exit(0);
});
