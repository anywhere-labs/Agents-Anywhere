import { StrictMode, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Icons } from "./components/Icons";
import {
  ServiceCard,
  ServiceHeader,
  ServiceRow,
  ServiceToggle,
} from "./components/ServicePrimitives";
import "./styles.css";

type Tab = "connect" | "logs" | "settings";
type ConnectorStatus = "stopped" | "starting" | "running" | "stopping" | "exited" | "error" | "expired credential";

type DesktopState = {
  status: ConnectorStatus;
  pid: number | null;
  exitCode: number | null;
  configPath: string;
  settingsPath: string;
  connectorDir: string;
  uvCommand: string;
  openAtLogin: boolean;
  startConnectorOnLaunch: boolean;
  hasConfig: boolean;
  authFailed: boolean;
  logs: string[];
};

type ConnectorConfig = {
  serverUrl: string;
  connectorId: string;
  connectorToken: string;
  heartbeatSeconds: number;
  reconnectSeconds: number;
  syncExistingOnConnect: boolean;
  syncIntervalSeconds: number;
};

type ConnectorDesktopApi = {
  getState: () => Promise<DesktopState>;
  getConfig: () => Promise<ConnectorConfig>;
  saveConfig: (config: ConnectorConfig) => Promise<ConnectorConfig>;
  start: () => Promise<DesktopState>;
  stop: () => Promise<DesktopState>;
  restart: () => Promise<DesktopState>;
  startPairing: (input: string) => Promise<PairingState | StartCommandResult>;
  cancelPairing: () => Promise<void>;
  startFromCommand: (input: string, options?: { save?: boolean }) => Promise<DesktopState | PairingState | StartCommandResult>;
  saveSettings: (settings: Partial<Pick<DesktopState, "openAtLogin" | "startConnectorOnLaunch" | "uvCommand">>) => Promise<DesktopState>;
  openConfigFolder: () => Promise<void>;
  onState: (callback: (state: DesktopState) => void) => () => void;
  onLog: (callback: (line: string) => void) => () => void;
  onPairing: (callback: (state: PairingState) => void) => () => void;
};

type PairingState = {
  status: "waiting" | "claimed" | "expired" | "consumed" | "cancelled" | "error";
  serverUrl?: string;
  pairingId?: string;
  code?: string;
  error?: string;
};

type StartCommandResult = {
  kind: "start-command";
  config: ConnectorConfig;
};

declare global {
  interface Window {
    connectorDesktop: ConnectorDesktopApi;
  }
}

function App() {
  const [tab, setTab] = useState<Tab>("connect");
  const [state, setState] = useState<DesktopState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [modal, setModal] = useState<null | "pair" | "command" | "save-command" | "missing-credentials" | "expired-credentials">(null);
  const [pairInput, setPairInput] = useState("");
  const [commandInput, setCommandInput] = useState("");
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const [parsedCommand, setParsedCommand] = useState<ConnectorConfig | null>(null);
  const [toast, setToast] = useState<{ kind: "error" | "warning"; message: string } | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    let mounted = true;
    window.connectorDesktop.getState()
      .then((nextState) => {
        if (!mounted) return;
        setState(nextState);
        setLogs(nextState.logs);
      })
      .catch((err: unknown) => setError(errorMessage(err)));

    const offState = window.connectorDesktop.onState((nextState) => {
      setState(nextState);
      setLogs(nextState.logs);
    });
    const offLog = window.connectorDesktop.onLog((line) => {
      setLogs((current) => [...current.slice(-399), line]);
    });
    const offPairing = window.connectorDesktop.onPairing((nextPairing) => {
      setPairing(nextPairing);
      if (nextPairing.status === "claimed") {
        setModal(null);
        setPairInput("");
        window.connectorDesktop.getState().then(setState);
      }
    });
    return () => {
      mounted = false;
      offState();
      offLog();
      offPairing();
    };
  }, []);

  const statusText = state?.status ?? "loading";
  const statusKind = statusClassName(statusText);
  const credentialsExpired = statusText === "expired credential" || !!state?.authFailed;
  const credentialBadge = credentialsExpired
    ? { className: "expired", text: "expired credential" }
    : state?.hasConfig
      ? { className: "saved", text: "credentials saved" }
      : { className: "missing", text: "no credentials" };

  useEffect(() => {
    if (error) setToast({ kind: "error", message: error });
  }, [error]);

  useEffect(() => {
    if (credentialsExpired) {
      setToast({ kind: "error", message: "Expired credential. Pair this connector again or paste a fresh start command." });
    }
  }, [credentialsExpired]);

  useEffect(() => {
    if (tab !== "logs" || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [tab, logs.length]);

  const runAction = async (action: "start" | "stop" | "restart") => {
    setError(null);
    try {
      setState(await window.connectorDesktop[action]());
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const toggleConnected = async (checked: boolean) => {
    if (checked && !state?.hasConfig) {
      setModal("missing-credentials");
      return;
    }
    if (checked && credentialsExpired) {
      setModal("expired-credentials");
      return;
    }
    await runAction(checked ? "start" : "stop");
  };

  const beginPairing = async () => {
    setError(null);
    try {
      const result = await window.connectorDesktop.startPairing(pairInput);
      if ("kind" in result && result.kind === "start-command") {
        setParsedCommand(result.config);
        setModal("save-command");
        return;
      }
      setPairing(result as PairingState);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const beginFromCommand = async () => {
    setError(null);
    try {
      const result = await window.connectorDesktop.startPairing(commandInput);
      if ("kind" in result && result.kind === "start-command") {
        setParsedCommand(result.config);
        setModal("save-command");
        return;
      }
      setModal("pair");
      setPairInput(commandInput);
      setPairing(result as PairingState);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const runParsedCommand = async (save: boolean) => {
    setError(null);
    try {
      const result = await window.connectorDesktop.startFromCommand(commandInput, { save });
      if ("status" in result && ("pid" in result || "hasConfig" in result)) {
        setState(result as DesktopState);
      }
      setModal(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const saveSettings = async (patch: Partial<Pick<DesktopState, "openAtLogin" | "startConnectorOnLaunch" | "uvCommand">>) => {
    setError(null);
    try {
      setState(await window.connectorDesktop.saveSettings(patch));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <main className="aa-desk" data-screen-label="Desktop Connector">
      <header className="aa-desk-top">
        <div className="aa-desk-brand">
          <span className="aa-desk-word">Agents Anywhere</span>
          <span className="aa-desk-product">Connector</span>
        </div>
        <nav className="aa-desk-tabs" aria-label="Desktop sections">
          <TabButton tab="connect" active={tab} onClick={setTab} title="Connect" icon={<Icons.Terminal size={15} />} />
          <TabButton tab="logs" active={tab} onClick={setTab} title="Logs" icon={<Icons.List size={15} />} />
          <TabButton tab="settings" active={tab} onClick={setTab} title="Settings" icon={<Icons.Settings size={15} />} />
        </nav>
        <span className={`aa-desk-status-dot ${statusKind}`} title={statusText} aria-label={`Connector status: ${statusText}`} />
      </header>

      {toast && (
        <Toast kind={toast.kind} message={toast.message} onClose={() => setToast(null)} />
      )}

      <section className="aa-desk-scroll">
        <div className={`aa-settings-main aa-desk-main ${tab === "logs" ? "logs-mode" : ""}`}>
          <ServiceHeader title={tabTitle(tab)} subtitle={tabSubtitle(tab)} />

          {tab === "connect" && (
            <div className="aa-settings-stack">
              <div className="aa-srv-card aa-connect-server-card">
                <ServiceToggle
                  title="Connect to server"
                  subtitle={credentialsExpired ? "Saved credentials are invalid. Pair again or paste a fresh start command." : state?.hasConfig ? "Use the saved connector credentials for this machine." : "Save credentials from a command or pairing flow before enabling."}
                  badge={<span className={"badge " + credentialBadge.className}>{credentialBadge.text}</span>}
                  checked={statusText === "running" || statusText === "starting"}
                  onChange={toggleConnected}
                />
              </div>

              <div className="aa-connect-choice-grid">
                <button type="button" className="aa-connect-choice" onClick={() => setModal("command")}>
                  <Icons.Terminal size={18} />
                  <strong>From command</strong>
                  <span>Paste a generated start or pair command from the web console.</span>
                </button>
                <button type="button" className="aa-connect-choice" onClick={() => setModal("pair")}>
                  <Icons.List size={18} />
                  <strong>Pair</strong>
                  <span>Enter a server address or pairing command and claim this desktop app from the web UI.</span>
                </button>
              </div>
            </div>
          )}

          {tab === "logs" && (
            <ServiceCard
              title="Connector logs"
              className="aa-desk-log-card"
              actions={
                <span className="aa-desk-muted">Last {logs.length} lines</span>
              }
            >
              <pre ref={logRef}>{logs.join("\n")}</pre>
            </ServiceCard>
          )}

          {tab === "settings" && (
            <div className="aa-settings-stack">
              <ServiceCard title="Startup">
                <ServiceToggle
                    title="Launch at system startup"
                    subtitle="Register the desktop controller as a login item and keep it available from the tray."
                    checked={!!state?.openAtLogin}
                    onChange={(openAtLogin) => saveSettings({ openAtLogin })}
                  />
                <ServiceToggle
                    title="Start connector when app opens"
                    subtitle="When a config exists, start the connector automatically as the desktop app launches."
                    checked={state?.startConnectorOnLaunch !== false}
                    onChange={(startConnectorOnLaunch) => saveSettings({ startConnectorOnLaunch })}
                  />
              </ServiceCard>

              <ServiceCard title="Runtime">
                <div className="aa-desk-form one">
                  <Field
                    label="uv command"
                    value={state?.uvCommand ?? "uv"}
                    onChange={(uvCommand) => setState((current) => current ? { ...current, uvCommand } : current)}
                    onBlur={(uvCommand) => saveSettings({ uvCommand })}
                  />
                  <ServiceRow label="Config path" value={<code>{state?.configPath ?? "-"}</code>} />
                  <ServiceRow label="Desktop settings" value={<code>{state?.settingsPath ?? "-"}</code>} />
                </div>
              </ServiceCard>
            </div>
          )}
        </div>
      </section>

      {modal === "pair" && (
        <Dialog title="Pair connector" onClose={() => setModal(null)}>
          {!pairing?.code ? (
            <>
              <p className="kl-pair-hint">
                Open the web console, create a device, copy the <span className="accent-text">pairing command</span>, then <span className="accent-text">paste</span> it here.
              </p>
              <label className="kl-form-row">
                <span className="kl-form-row-head">
                  <button type="button" className="kl-pair-inline-link" onClick={() => setPairInput("https://")}>
                    You can also enter the server address directly.
                  </button>
                </span>
                <input value={pairInput} onChange={(event) => setPairInput(event.target.value)} placeholder="uvx anywhere-cli pair https://example.com" />
              </label>
              <div className="kl-modal-actions">
                <button type="button" className="kl-btn ghost" onClick={() => setModal(null)}>Cancel</button>
                <button type="button" className="kl-btn primary" onClick={beginPairing}>Start pairing</button>
              </div>
            </>
          ) : (
            <>
              <p className="kl-pair-hint">Enter this pairing code in the web pairing screen to finish connecting this machine.</p>
              <div className="kl-pair-code-display">{pairing.code}</div>
              <p className="kl-pair-status">Waiting for claim from <span className="token">{pairing.serverUrl}</span></p>
              <div className="kl-modal-actions">
                <button type="button" className="kl-btn ghost" onClick={() => { window.connectorDesktop.cancelPairing(); setModal(null); }}>Cancel</button>
              </div>
            </>
          )}
        </Dialog>
      )}

      {modal === "command" && (
        <Dialog title="Start from command" onClose={() => setModal(null)}>
          <p className="kl-pair-hint"><span className="accent-text">Paste the command</span> generated by the web console.</p>
          <label className="kl-form-row">
            <span>CONNECTOR COMMAND</span>
            <input value={commandInput} onChange={(event) => setCommandInput(event.target.value)} placeholder="uvx anywhere-cli start --server-url ... --connector-id ... --connector-token ..." />
          </label>
          <div className="kl-modal-actions">
            <button type="button" className="kl-btn ghost" onClick={() => setModal(null)}>Cancel</button>
            <button type="button" className="kl-btn primary" onClick={beginFromCommand}>Continue</button>
          </div>
        </Dialog>
      )}

      {modal === "save-command" && parsedCommand && (
        <Dialog title="Save credentials?" onClose={() => setModal(null)}>
          <p className="kl-pair-hint">This start command contains connector credentials for <code>{parsedCommand.serverUrl}</code>.</p>
          <p className="kl-pair-hint">Save them to this desktop app so the connect switch and startup settings can use them later?</p>
          <div className="kl-modal-actions">
            <button type="button" className="kl-btn ghost" onClick={() => runParsedCommand(false)}>Run once</button>
            <button type="button" className="kl-btn primary" onClick={() => runParsedCommand(true)}>Save and start</button>
          </div>
        </Dialog>
      )}

      {modal === "missing-credentials" && (
        <Dialog title="Credentials required" onClose={() => setModal(null)}>
          <p className="kl-pair-hint">Configure this connector with one of the options below first.</p>
          <div className="kl-modal-actions">
            <button type="button" className="kl-btn primary" onClick={() => setModal(null)}>OK</button>
          </div>
        </Dialog>
      )}

      {modal === "expired-credentials" && (
        <Dialog title="Expired credential" onClose={() => setModal(null)}>
          <p className="kl-pair-hint">Pair this connector again or paste a fresh start command.</p>
          <div className="kl-modal-actions">
            <button type="button" className="kl-btn primary" onClick={() => setModal(null)}>OK</button>
          </div>
        </Dialog>
      )}
    </main>
  );
}

function Toast({ kind, message, onClose }: { kind: "error" | "warning"; message: string; onClose: () => void }) {
  return (
    <div className={`aa-toast ${kind}`} role="status">
      <span>{message}</span>
      <button type="button" onClick={onClose} aria-label="Dismiss">×</button>
    </div>
  );
}

function TabButton({ tab, active, onClick, title, icon }: { tab: Tab; active: Tab; onClick: (tab: Tab) => void; title: string; icon: ReactNode }) {
  return (
    <button type="button" className={active === tab ? "on" : ""} onClick={() => onClick(tab)}>
      {icon}
      <span className="aa-desk-tab-title">{title}</span>
    </button>
  );
}

function Field({ label, value, onChange, onBlur, type = "text", placeholder, wide = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: (value: string) => void;
  type?: string;
  placeholder?: string;
  wide?: boolean;
}) {
  return (
    <label className={wide ? "kl-form-row wide" : "kl-form-row"}>
      <span>{label}</span>
      <input type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} onBlur={(event) => onBlur?.(event.target.value)} />
    </label>
  );
}

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="kl-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="kl-modal kl-pair" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="kl-pair-hd">
          <h3>{title}</h3>
          <button type="button" className="x" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function tabTitle(tab: Tab) {
  if (tab === "logs") return "Logs";
  if (tab === "settings") return "Settings";
  return "Connect";
}

function tabSubtitle(tab: Tab) {
  if (tab === "logs") return "Connector stdout and stderr from the local daemon.";
  if (tab === "settings") return "Startup, tray, and uv source-run preferences.";
  return "Start and configure the local connector for this machine.";
}

function errorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  return String(err);
}

function statusClassName(status: string) {
  return status.replace(/\s+/g, "-").toLowerCase();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
