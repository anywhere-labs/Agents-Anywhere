import { useCallback, useEffect, useRef, useState } from "react";
import { Icons } from "../../../../components/Icons";
import type { RuntimeApi, TerminalView } from "./runtimeApi";

type Props = {
  api: RuntimeApi;
  onClose: () => void;
  // When true, the host re-mounts the xterm host on visibility (e.g. after
  // a panel toggle). The panel doesn't currently need this — included for
  // future use.
  hostKey?: string;
  primary?: boolean;
  showClose?: boolean;
  title?: string;
  onPopOut?: () => void;
};

function makeTerminalGroupId() {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `termgrp_${random}`;
}

/** Multi-tab interactive terminal. Tabs are local to this mounted panel:
 * the backend/connector PTY is created on tab creation and destroyed when
 * the browser WS disconnects or the tab/panel closes. */
export function TerminalPanel({
  api,
  onClose,
  primary = false,
  showClose = true,
  title = "Terminal",
  onPopOut,
}: Props) {
  const [terms, setTerms] = useState<TerminalView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const termsRef = useRef<TerminalView[]>([]);
  const terminalGroupIdRef = useRef(makeTerminalGroupId());

  useEffect(() => {
    termsRef.current = terms;
  }, [terms]);

  useEffect(() => {
    setTerms([]);
    setActiveId(null);
    setRenamingId(null);
    setRenameText("");
    setError(null);
    setBusy(false);
    terminalGroupIdRef.current = makeTerminalGroupId();
  }, [api.sessionId]);

  // On mount: create a fresh terminal for this panel. Ordinary panel
  // terminals are intentionally not restored from the server.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (primary) {
          const created = await api.ensurePrimaryTerminal();
          if (cancelled) return;
          setTerms([created.terminal]);
          setActiveId(created.terminal.terminalId);
          return;
        }
        const created = await api.createTerminal({
          cols: 80,
          rows: 24,
          ephemeralGroupId: terminalGroupIdRef.current,
        });
        if (cancelled) return;
        setTerms([created.terminal]);
        setActiveId(created.terminal.terminalId);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (!primary) {
        for (const term of termsRef.current) {
          void api.closeTerminal(term.terminalId).catch(() => undefined);
        }
      }
    };
  }, [api, primary]);

  const addTerminal = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createTerminal({
        cols: 80,
        rows: 24,
        ephemeralGroupId: terminalGroupIdRef.current,
      });
      setTerms((prev) => [...prev, r.terminal]);
      setActiveId(r.terminal.terminalId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [api]);

  const closeTerminal = useCallback(
    async (tid: string) => {
      try {
        await api.closeTerminal(tid);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      setTerms((prev) => {
        const next = prev.filter((t) => t.terminalId !== tid);
        if (activeId === tid) setActiveId(next[0]?.terminalId ?? null);
        return next;
      });
    },
    [api, activeId],
  );

  const renameTerminal = useCallback(
    async (tid: string, label: string) => {
      setTerms((prev) => prev.map((t) => (t.terminalId === tid ? { ...t, label } : t)));
      setRenamingId(null);
    },
    [],
  );

  return (
    <div className="kl-rt-pane kl-term">
      <div className="kl-rt-hd">
        <div className="title">
          <Icons.Terminal size={14} /> {title}
        </div>
        <span className="sep" />
        <div className="acts">
          {onPopOut && (
            <button className="iconbtn" title="Open in window" onClick={onPopOut}>
              <Icons.External size={13} />
            </button>
          )}
          {!primary && showClose && (
            <button className="iconbtn" title="Close panel" onClick={onClose}>
              <Icons.X size={13} />
            </button>
          )}
        </div>
      </div>
      {!primary && <div className="kl-term-tabs" role="tablist">
        {terms.map((t) =>
          renamingId === t.terminalId ? (
            <input
              key={t.terminalId}
              className="kl-term-tab active"
              value={renameText}
              autoFocus
              onChange={(e) => setRenameText(e.target.value)}
              onBlur={() => renameTerminal(t.terminalId, renameText.trim() || t.label)}
              onKeyDown={(e) => {
                if (e.key === "Enter") renameTerminal(t.terminalId, renameText.trim() || t.label);
                if (e.key === "Escape") setRenamingId(null);
              }}
              style={{ width: 120, padding: "0 8px" }}
            />
          ) : (
            <button
              key={t.terminalId}
              role="tab"
              className={
                "kl-term-tab" +
                (activeId === t.terminalId ? " active" : "") +
                (t.status === "exited" ? " exited" : "")
              }
              onClick={() => setActiveId(t.terminalId)}
              onDoubleClick={() => {
                setRenamingId(t.terminalId);
                setRenameText(t.label);
              }}
              title={`${t.label} · pid ${t.pid ?? "?"}${t.status === "exited" ? ` (exit ${t.exitCode ?? "?"})` : ""}\nDouble-click to rename`}
            >
              <span className="dot" />
              <span className="label">{t.label}</span>
              {terms.length > 0 && (
                <span
                  className="close"
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeTerminal(t.terminalId);
                  }}
                  aria-label={`Close ${t.label}`}
                >
                  <Icons.X size={11} />
                </span>
              )}
            </button>
          ),
        )}
        <button
          className="kl-term-add"
          onClick={addTerminal}
          disabled={busy}
          title="New terminal"
          aria-label="New terminal"
        >
          <Icons.Plus size={14} />
        </button>
      </div>}
      <div className="kl-term-host">
        {error && <div className="kl-term-status" style={{ color: "#f6a4a4" }}>{error}</div>}
        {terms.map((term) => (
          <div
            key={`${api.sessionId}:${term.terminalId}`}
            className={
              "kl-term-host-layer" +
              (activeId === term.terminalId ? " active" : "")
            }
          >
            <XtermHost
              terminal={term}
              active={activeId === term.terminalId}
              api={api}
              onError={(m) => setError(m)}
              onClosed={() => {
                if (primary) return;
                setTerms((prev) => {
                  const next = prev.filter((item) => item.terminalId !== term.terminalId);
                  setActiveId((cur) => (cur === term.terminalId ? next[0]?.terminalId ?? null : cur));
                  return next;
                });
              }}
            />
          </div>
        ))}
        {terms.length === 0 && !error && (
          <div className="kl-term-status">No terminal</div>
        )}
      </div>
    </div>
  );
}

// ── Single xterm.js host bound to a websocket ─────────────────────────

function XtermHost({
  terminal,
  active,
  api,
  onError,
  onClosed,
}: {
  terminal: TerminalView;
  active: boolean;
  api: RuntimeApi;
  onError: (m: string) => void;
  onClosed: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed" | "exited">("connecting");

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    let term: import("@xterm/xterm").Terminal | null = null;
    let fit: import("@xterm/addon-fit").FitAddon | null = null;
    let socket: WebSocket | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let lastSeenSeq = 0;
    let lastSentSize: { cols: number; rows: number } | null = null;
    let pendingInput = "";
    let resizeFrame: number | null = null;

    const sendResize = () => {
      if (!term || !socket || socket.readyState !== WebSocket.OPEN) return;
      const cols = term.cols;
      const rows = term.rows;
      if (lastSentSize?.cols === cols && lastSentSize.rows === rows) return;
      lastSentSize = { cols, rows };
      socket.send(JSON.stringify({ type: "resize", cols, rows }));
    };

    (async () => {
      const [{ Terminal }, { FitAddon }, { SearchAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-search"),
        import("@xterm/addon-web-links"),
      ]);
      await import("@xterm/xterm/css/xterm.css");
      if (cancelled) return;
      term = new Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        fontSize: 12.5,
        fontFamily: '"Menlo", "JetBrains Mono", "SF Mono", monospace',
        theme: {
          background: "#08080a",
          foreground: "#d4d4d4",
          cursor: "#d4d4d4",
          selectionBackground: "rgba(255,255,255,0.15)",
        },
        scrollback: 5000,
        convertEol: true,
        allowProposedApi: true,
      });
      fit = new FitAddon();
      const search = new SearchAddon();
      const links = new WebLinksAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      term.loadAddon(links);
      term.open(host);
      fit.fit();
      // Grab focus right away — without this, keystrokes go to whatever was
      // focused before (e.g. the file tree), and `onData` never fires.
      term.focus();

      // In demo mode, skip the websocket entirely and just write a banner
      // + a live cursor. Lets the UI be exercised without a backend.
      if (api.demo) {
        const t = term;
        setStatus("open");
        t.writeln("\x1b[2m# demo terminal · no backend connected\x1b[0m");
        t.writeln("\x1b[38;5;108mbenson@air\x1b[0m \x1b[38;5;73m~/code/happy\x1b[0m \x1b[2mon\x1b[0m \x1b[38;5;179mfeat/oauth\x1b[0m");
        t.write("\x1b[38;5;179m›\x1b[0m ");
        t.onData((data) => {
          // Echo locally so the cursor moves and the user can "type".
          if (data === "\r") {
            t.write("\r\n\x1b[38;5;108mbenson@air\x1b[0m \x1b[38;5;73m~/code/happy\x1b[0m \x1b[2mon\x1b[0m \x1b[38;5;179mfeat/oauth\x1b[0m\r\n\x1b[38;5;179m›\x1b[0m ");
          } else if (data === "") {
            t.write("\b \b");
          } else {
            t.write(data);
          }
        });
        return;
      }

      // Forward keystrokes to the websocket.
      term.onData((data) => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "input", data: utf8ToBase64(data) }));
        } else {
          pendingInput += data;
        }
      });

      // Resize: react to host resize via ResizeObserver, push to server.
      resizeObserver = new ResizeObserver(() => {
        if (!fit || !term) return;
        if (resizeFrame != null) cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = null;
          if (!fit || !term) return;
          try {
            fit.fit();
          } catch {
            /* host not measured yet */
          }
          sendResize();
        });
      });
      resizeObserver.observe(host);

      // Open the websocket.
      const url = api.streamUrl(terminal.terminalId, 0);
      socket = new WebSocket(url);
      socket.addEventListener("open", () => {
        if (cancelled) return;
        setStatus("open");
        // After connect, push initial size to server.
        sendResize();
        // Flush any queued input.
        if (pendingInput && socket) {
          socket.send(JSON.stringify({ type: "input", data: utf8ToBase64(pendingInput) }));
          pendingInput = "";
        }
      });
      socket.addEventListener("message", (ev) => {
        if (!term) return;
        try {
          const frame = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data));
          if (frame.type === "replay" || frame.type === "output") {
            if (typeof frame.seq === "number" && frame.seq <= lastSeenSeq) return;
            if (typeof frame.seq === "number") {
              lastSeenSeq = frame.seq;
            }
            term.write(base64ToBytes(frame.data));
          } else if (frame.type === "exit") {
            setStatus("exited");
            term.writeln("");
            term.writeln(
              `\x1b[2m[process exited${frame.exitCode != null ? ` with code ${frame.exitCode}` : ""}]\x1b[0m`,
            );
          } else if (frame.type === "error") {
            onError(`${frame.code}: ${frame.message}`);
          }
        } catch {
          // ignore
        }
      });
      socket.addEventListener("close", () => {
        if (cancelled) return;
        setStatus((s) => (s === "exited" ? "exited" : "closed"));
        onClosed();
      });
      socket.addEventListener("error", () => {
        onError("websocket error");
      });
    })().catch((e) => {
      onError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      cancelled = true;
      if (resizeFrame != null) cancelAnimationFrame(resizeFrame);
      resizeObserver?.disconnect();
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
      term?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.sessionId, terminal.terminalId]);

  // Refocus xterm whenever the host is clicked. xterm.js auto-focuses on
  // its own canvas, but if the click lands on padding / edge area we want
  // to forward it. Belt-and-braces with the explicit focus() above.
  useEffect(() => {
    if (!active) return;
    const host = hostRef.current;
    const helper = host?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    helper?.focus();
  }, [active]);

  const handleHostClick = () => {
    const host = hostRef.current;
    if (!host) return;
    // The Terminal instance lives in a closure inside the effect; we reach
    // it via the host's xterm-helper-textarea, which is what receives keys.
    const helper = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    helper?.focus();
  };

  return (
    <>
      <div
        ref={hostRef}
        onClick={handleHostClick}
        style={{ position: "absolute", inset: 0 }}
      />
      {status !== "open" && (
        <div className="kl-term-status">
          {status === "connecting" && "connecting…"}
          {status === "closed" && "disconnected"}
          {status === "exited" && "exited"}
        </div>
      )}
    </>
  );
}

function utf8ToBase64(s: string): string {
  // btoa() doesn't handle multi-byte chars — encode to UTF-8 bytes first.
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
