import { useEffect, useRef } from "react";

export type IncomingFrame =
  | { type: "replay"; data: string; seq: number }
  | { type: "output"; data: string; seq: number }
  | { type: "exit"; exitCode: number | null; reason?: string }
  | { type: "error"; code: number; message: string }
  | { type: "pong" };

export type TerminalSocketOptions = {
  url: string;
  // Called whenever a frame arrives. Caller is responsible for writing it
  // to xterm.js (base64-decode data → terminal.write).
  onFrame: (frame: IncomingFrame) => void;
  // Called when the WS is open and the caller can start sending input.
  onOpen?: () => void;
  // Called when the WS closes (any reason). Caller should display a
  // disconnected indicator.
  onClose?: (ev: CloseEvent) => void;
};

export type TerminalSocket = {
  send: (data: string) => void; // base64 input bytes
  resize: (cols: number, rows: number) => void;
  close: () => void;
};

/**
 * Thin wrapper around WebSocket with a single-attempt reconnect (so
 * transient network blips don't kill the panel). Caller-supplied url is
 * expected to embed the auth token; we don't manage tokens here.
 */
export function useTerminalSocket(opts: TerminalSocketOptions | null) {
  const ref = useRef<TerminalSocket | null>(null);
  const live = useRef<{ url: string; ws: WebSocket } | null>(null);

  useEffect(() => {
    if (!opts) return;
    const { url, onFrame, onOpen, onClose } = opts;
    let closedManually = false;
    let retried = false;

    const connect = () => {
      const ws = new WebSocket(url);
      live.current = { url, ws };
      ws.binaryType = "arraybuffer";
      ws.addEventListener("open", () => {
        onOpen?.();
      });
      ws.addEventListener("message", (ev) => {
        try {
          const data = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
          const frame = JSON.parse(data) as IncomingFrame;
          onFrame(frame);
        } catch {
          // ignore malformed frame
        }
      });
      ws.addEventListener("close", (ev) => {
        live.current = null;
        if (closedManually) {
          onClose?.(ev);
          return;
        }
        if (!retried) {
          retried = true;
          // One-shot reconnect after a short delay.
          setTimeout(connect, 800);
          return;
        }
        onClose?.(ev);
      });
      ws.addEventListener("error", () => {
        // Let close handler do the work.
      });
    };

    connect();

    ref.current = {
      send: (data: string) => {
        const ws = live.current?.ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      },
      resize: (cols: number, rows: number) => {
        const ws = live.current?.ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      },
      close: () => {
        closedManually = true;
        const ws = live.current?.ws;
        if (ws) ws.close();
      },
    };

    return () => {
      closedManually = true;
      const ws = live.current?.ws;
      if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
      live.current = null;
      ref.current = null;
    };
  }, [opts]);

  return ref;
}
