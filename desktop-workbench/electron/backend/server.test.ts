import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorLogEntry, DesktopSettings } from "../connector-types";
import type { OwnershipState } from "../local-runtime";
import { BACKEND_TOKEN_HEADER } from "./protocol";
import { BackendServer } from "./server";
import type { BackendState } from "./state";

const SETTINGS: DesktopSettings = {
  openAtLogin: false,
  startConnectorOnLaunch: true,
  silentLaunch: true,
  notificationsEnabled: true,
  uvPath: "",
  uvPypiIndexUrl: "",
  logChunkSizeKb: 512,
  logRetainChunks: 20,
  logRetentionDays: 14,
};

/** Minimal stand-in: this test covers the transport, not the services. */
class FakeState {
  readonly listeners = new Map<string, Set<(data: unknown) => void>>();
  ownership: OwnershipState = { status: "error", message: "正在检查本机 Connector…" };
  appended: Array<Record<string, unknown>> = [];
  cleared = 0;

  on(event: string, listener: (data: unknown) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }

  off(event: string, listener: (data: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, data: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(data);
  }

  ownershipState(): OwnershipState {
    return this.ownership;
  }

  getSettings(): DesktopSettings {
    return SETTINGS;
  }

  getConnectorState(): Promise<{ running: boolean }> {
    return Promise.resolve({ running: false });
  }

  getPublicConfig(): { connectorId: string } {
    return { connectorId: "conn_1" };
  }

  readLogs(): { items: ConnectorLogEntry[]; total: number } {
    return { items: [], total: 0 };
  }

  clearLogs(): { items: ConnectorLogEntry[]; total: number } {
    this.cleared += 1;
    this.emit("logsCleared", undefined);
    return { items: [], total: 0 };
  }

  appendLog(entry: Record<string, unknown>): void {
    this.appended.push(entry);
  }

  exportLogs(filePath: string): number {
    return filePath.length;
  }

  setServerConnection(input: { serverUrl?: unknown; apiNamespace?: unknown }): { serverUrl: string; apiNamespace: string } {
    const connection = { serverUrl: String(input?.serverUrl ?? ""), apiNamespace: String(input?.apiNamespace ?? "") };
    this.serverConnection = connection;
    return connection;
  }

  serverConnection: { serverUrl: string; apiNamespace: string } | null = null;
}

async function withServer(run: (base: string, token: string, state: FakeState) => Promise<void>): Promise<void> {
  const state = new FakeState();
  const server = new BackendServer(state as unknown as BackendState);
  const { port, token } = await server.start();
  try {
    await run(`http://127.0.0.1:${port}`, token, state);
  } finally {
    await server.close();
  }
}

test("loopback requests require the per-launch token", async () => {
  await withServer(async (base) => {
    const unauthorized = await fetch(`${base}/state`);
    assert.equal(unauthorized.status, 401);
  });
});

test("routes reach the backend state and unknown routes fail loudly", async () => {
  await withServer(async (base, token, state) => {
    const headers = { [BACKEND_TOKEN_HEADER]: token, "content-type": "application/json" };
    const stateResponse = await fetch(`${base}/state`, { headers });
    assert.equal(stateResponse.status, 200);
    assert.deepEqual(await stateResponse.json(), { running: false });

    const appendResponse = await fetch(`${base}/logs/append`, {
      method: "POST",
      headers,
      body: JSON.stringify({ level: "ERROR", message: "boom" }),
    });
    assert.equal(appendResponse.status, 200);
    assert.deepEqual(state.appended, [{ level: "ERROR", message: "boom" }]);

    const clearResponse = await fetch(`${base}/logs/clear`, { method: "POST", headers, body: "{}" });
    assert.equal(clearResponse.status, 200);
    assert.equal(state.cleared, 1);

    const missing = await fetch(`${base}/nope`, { headers });
    assert.equal(missing.status, 400);
  });
});

test("a sign-in can repoint the backend at another server", async () => {
  await withServer(async (base, token, state) => {
    const headers = { [BACKEND_TOKEN_HEADER]: token, "content-type": "application/json" };
    const response = await fetch(`${base}/server`, {
      method: "POST",
      headers,
      body: JSON.stringify({ serverUrl: "http://192.168.112.26:5174", apiNamespace: "/api/v2" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(state.serverConnection, { serverUrl: "http://192.168.112.26:5174", apiNamespace: "/api/v2" });
  });
});

test("the event stream sends the current snapshot and then batched log events", async () => {
  await withServer(async (base, token, state) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/events`, {
      headers: { [BACKEND_TOKEN_HEADER]: token, accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const frames: Array<{ event: string; data: unknown }> = [];
    let buffer = "";

    const readFrame = async (): Promise<void> => {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let event = "message";
          const data: string[] = [];
          for (const line of frame.split("\n")) {
            if (!line || line.startsWith(":")) continue;
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trim());
          }
          if (data.length > 0) {
            frames.push({ event, data: JSON.parse(data.join("\n")) as unknown });
            return;
          }
          // Frames without data (the initial `retry:` hint) are skipped.
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("event stream ended early");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };

    await readFrame();
    // The placeholder ownership value is withheld until the first real probe.
    assert.deepEqual(frames.map((frame) => frame.event), ["settings"]);

    state.emit("ownership", { status: "owned" });
    await readFrame();
    assert.equal(frames[1]?.event, "ownership");
    assert.deepEqual(frames[1]?.data, { status: "owned" });

    state.emit("logs", [{ seq: 1, level: "INFO", message: "one", time: "2026-01-01T00:00:00.000Z" }]);
    await readFrame();
    assert.equal(frames[2]?.event, "logs");
    assert.deepEqual(frames[2]?.data, [{ seq: 1, level: "INFO", message: "one", time: "2026-01-01T00:00:00.000Z" }]);

    controller.abort();
  });
});
