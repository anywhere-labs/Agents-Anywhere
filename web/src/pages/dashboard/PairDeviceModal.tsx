import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  ApiError,
  api,
  type ConnectorCreateResponse,
  type ConnectorRevokeResponse,
  type ConnectorView,
} from "../../lib/api";
import { Icons } from "../../components/Icons";

const POLL_INTERVAL_MS = 3000;
const DEVICE_NAME_ADJECTIVES = [
  "Amber",
  "Bright",
  "Calm",
  "Cedar",
  "Clear",
  "Copper",
  "Delta",
  "Harbor",
  "Ivory",
  "Maple",
  "North",
  "Quiet",
  "River",
  "Silver",
  "Slate",
  "Swift",
] as const;
const DEVICE_NAME_NOUNS = [
  "Desktop",
  "Laptop",
  "Mac",
  "Machine",
  "Node",
  "Studio",
  "Terminal",
  "Workstation",
] as const;

type Credential = ConnectorCreateResponse | ConnectorRevokeResponse;

type MintState =
  | { kind: "idle" }
  | { kind: "minting" }
  | { kind: "ready"; credential: Credential }
  | { kind: "error"; message: string };

type PairStep = "create" | "choose" | "token" | "code" | "connected";

type PairDeviceModalProps = {
  token: string;
  initialCredential?: Credential | null;
  title?: string;
  onCancel: () => void;
  onPaired: (connector: ConnectorView) => void;
};

export function PairDeviceModal({
  token,
  initialCredential = null,
  title,
  onCancel,
  onPaired,
}: PairDeviceModalProps) {
  const [deviceName, setDeviceName] = useState(
    initialCredential?.connector.name || readableDeviceName(),
  );
  const [mint, setMint] = useState<MintState>(() =>
    initialCredential
      ? { kind: "ready", credential: initialCredential }
      : { kind: "idle" },
  );
  const [step, setStep] = useState<PairStep>(
    initialCredential ? "choose" : "create",
  );
  const [pairCode, setPairCode] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [waitingForOnline, setWaitingForOnline] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [connected, setConnected] = useState<ConnectorView | null>(null);
  const [copied, setCopied] = useState<"token" | "pair" | null>(null);
  const [exitConfirm, setExitConfirm] = useState(false);

  const mintingRef = useRef(false);
  const backdropPointerStartedRef = useRef(false);

  const credential = mint.kind === "ready" ? mint.credential : null;
  const connectorId = credential?.connector.id ?? "";
  const connectorToken = credential?.connectorToken ?? "";
  const serverUrl = browserServerUrl();

  const startCmd = useMemo(() => {
    if (!credential) return "";
    return [
      "uvx anywhere-cli start",
      `--server-url ${shellQuote(serverUrl)}`,
      `--connector-id ${shellQuote(connectorId)}`,
      `--connector-token ${shellQuote(connectorToken)}`,
    ].join(" ");
  }, [connectorId, connectorToken, credential, serverUrl]);

  const pairCmd = useMemo(
    () => `uvx anywhere-cli pair ${shellQuote(pairServerAddress(serverUrl))}`,
    [serverUrl],
  );

  const generate = () => {
    if (mintingRef.current) return;
    const name = deviceName.trim() || readableDeviceName();
    mintingRef.current = true;
    setMint({ kind: "minting" });
    setClaimError(null);
    api
      .createConnector(token, { name })
      .then((res) => {
        setMint({ kind: "ready", credential: res });
        setStep("choose");
      })
      .catch((err: unknown) => {
        const message =
          err instanceof ApiError
            ? err.detail
            : err instanceof Error
              ? err.message
              : "Failed to generate connector token.";
        setMint({ kind: "error", message });
        mintingRef.current = false;
      });
  };

  useEffect(() => {
    if (!initialCredential) return;
    setDeviceName(initialCredential.connector.name);
    setMint({ kind: "ready", credential: initialCredential });
    setStep("choose");
  }, [initialCredential]);

  useEffect(() => {
    if (!credential || connected) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const list = await api.listConnectors(token);
        if (cancelled) return;
        const me = list.connectors.find((c) => c.id === credential.connector.id);
        if (me && me.status === "online") {
          setConnected(me);
          setWaitingForOnline(false);
          setStep("connected");
          return;
        }
      } catch {
        // transient polling failure
      }
      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
    };
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [connected, credential, token]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleDone();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const copy = async (which: "token" | "pair", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard may be blocked in some browser contexts
    }
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  };

  const claimPairCode = () => {
    if (!credential || claiming || waitingForOnline) return;
    const code = pairCode.trim().toUpperCase();
    if (!code) {
      setClaimError("Enter the code shown by uvx anywhere-cli pair.");
      return;
    }
    setClaiming(true);
    setClaimError(null);
    api
      .claimPairing(token, {
        code,
        name: deviceName.trim() || credential.connector.name || readableDeviceName(),
        serverUrl,
        connectorId,
        connectorToken,
      })
      .then((res) => {
        if (res.connector?.status === "online") {
          setConnected(res.connector);
          setWaitingForOnline(false);
          setStep("connected");
          return;
        }
        setWaitingForOnline(true);
      })
      .catch((err: unknown) => {
        const message =
          err instanceof ApiError
            ? err.detail
            : err instanceof Error
              ? err.message
              : "Failed to claim pairing code.";
        setClaimError(message);
        setWaitingForOnline(false);
      })
      .finally(() => setClaiming(false));
  };

  const handleDone = () => {
    if (connected) onPaired(connected);
    else onCancel();
  };
  const requestClose = () => {
    if (connected || !credential) {
      handleDone();
      return;
    }
    setExitConfirm(true);
  };
  const onBackdropPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    backdropPointerStartedRef.current = event.target === event.currentTarget;
  };
  const onBackdropPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (
      event.target !== event.currentTarget ||
      !backdropPointerStartedRef.current
    ) {
      backdropPointerStartedRef.current = false;
      return;
    }
    backdropPointerStartedRef.current = false;
    requestClose();
  };

  const modalTitle =
    title || (initialCredential ? "Reconnect device" : "Pair a new device");

  return (
    <div
      className="kl-modal-backdrop"
      onPointerDown={onBackdropPointerDown}
      onPointerUp={onBackdropPointerUp}
    >
      <div
        className="kl-modal kl-pair"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={modalTitle}
      >
        <div className="kl-pair-hd">
          <h3>{modalTitle}</h3>
          <button
            type="button"
            className="x"
            onClick={requestClose}
            aria-label="Close"
          >
            <Icons.X size={13} />
          </button>
        </div>

        {step === "create" || !credential ? (
          <>
            <p className="kl-pair-hint">
              Name this device, then generate a one-time connector token.
            </p>
            <label className="kl-form-row">
              <span>Device name</span>
              <input
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") generate();
                }}
                autoFocus
              />
            </label>
            {mint.kind === "error" && (
              <p className="kl-pair-error">{mint.message}</p>
            )}
            <div className="kl-pair-actions">
              <button type="button" className="kl-btn ghost" onClick={onCancel}>
                Cancel
              </button>
              <button
                type="button"
                className="kl-btn primary"
                onClick={generate}
                disabled={mint.kind === "minting"}
              >
                {mint.kind === "minting" ? "Generating..." : "Generate token"}
              </button>
            </div>
          </>
        ) : step === "choose" ? (
          <>
            <p className="kl-pair-hint">
              Credentials are ready for {credential.connector.name}. Pick one
              path to connect this device.
            </p>
            <div className="kl-pair-choice-grid">
              <button
                type="button"
                className="kl-pair-choice"
                onClick={() => setStep("token")}
              >
                <Icons.Key size={16} />
                <strong>Use token</strong>
                <span>Start the connector directly with this id and token.</span>
              </button>
              <button
                type="button"
                className="kl-pair-choice"
                onClick={() => setStep("code")}
              >
                <Icons.Terminal size={16} />
                <strong>Pair code</strong>
                <span>Run pair on the target machine and claim its code here.</span>
              </button>
            </div>
            <ConnectionStatus connected={connected} connectorId={connectorId} />
          </>
        ) : step === "token" ? (
          <>
            <BackButton onClick={() => setStep("choose")} />
            <p className="kl-pair-hint">
              Run this command on the machine that should connect to this server.
            </p>
            <CommandBlock
              cmd={startCmd}
              copied={copied === "token"}
              onCopy={() => copy("token", startCmd)}
            />
            <ConnectionStatus connected={connected} connectorId={connectorId} />
            <div className="kl-pair-actions">
              <button type="button" className="kl-btn ghost" onClick={requestClose}>
                Close
              </button>
            </div>
          </>
        ) : step === "code" ? (
          <>
            <BackButton onClick={() => setStep("choose")} />
            <p className="kl-pair-hint">
              Run the pairing command on the device, then paste the code shown
              by the connector CLI.
            </p>
            <div className="kl-pair-code-flow">
              <CommandBlock
                cmd={pairCmd}
                copied={copied === "pair"}
                onCopy={() => copy("pair", pairCmd)}
              />
              <div className="kl-pair-code-row">
                <input
                  value={pairCode}
                  onChange={(e) =>
                    setPairCode(e.target.value.toUpperCase().slice(0, 12))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") claimPairCode();
                  }}
                  placeholder="PAIR CODE"
                  aria-label="Pairing code"
                  disabled={claiming || waitingForOnline}
                />
                <button
                  type="button"
                  className="kl-btn primary"
                  onClick={claimPairCode}
                  disabled={claiming || waitingForOnline}
                >
                  {claiming || waitingForOnline ? (
                    <>
                      <span className="spin tiny" />
                      {claiming ? "Claiming..." : "Waiting for device"}
                    </>
                  ) : (
                    "Claim"
                  )}
                </button>
              </div>
              {claimError && <p className="kl-pair-error">{claimError}</p>}
            </div>
            <ConnectionStatus connected={connected} connectorId={connectorId} />
          </>
        ) : (
          <>
            <div className="kl-pair-ready">
              <Icons.Check size={18} />
            </div>
            <p className="kl-pair-hint">
              {connected?.name ?? credential.connector.name} is online and ready
              to sync sessions from this machine.
            </p>
            <ConnectionStatus connected={connected} connectorId={connectorId} />

            <div className="kl-pair-actions">
              <button type="button" className="kl-btn ghost" onClick={handleDone}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
      {exitConfirm && (
        <div className="kl-pair-exit" onClick={(e) => e.stopPropagation()}>
          <div className="kl-pair-exit-box">
            <h4>Exit setup?</h4>
            <p>
              This device will stay offline until you run setup again. The
              connector record will remain.
            </p>
            <div className="kl-pair-actions">
              <button
                type="button"
                className="kl-btn ghost"
                onClick={() => setExitConfirm(false)}
              >
                Continue setup
              </button>
              <button type="button" className="kl-btn primary" onClick={onCancel}>
                Exit setup
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="kl-pair-back" onClick={onClick}>
      <Icons.ChevRight size={13} style={{ transform: "rotate(180deg)" }} />
      Back
    </button>
  );
}

function ConnectionStatus({
  connected,
  connectorId,
}: {
  connected: ConnectorView | null;
  connectorId: string;
}) {
  return (
    <div
      className={"kl-pair-status" + (connected ? " connected" : "")}
      aria-live="polite"
    >
      <span>{connected ? "Connected" : "Waiting for connection"}</span>
      <span className="token">
        id <b>{connectorId}</b>
      </span>
    </div>
  );
}

function CommandBlock({
  cmd,
  copied,
  onCopy,
}: {
  cmd: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="kl-pair-cmd">
      <span className="sigil">$</span>
      <code>
        {cmd.split(" ").map((part, index) => (
          <span key={`${part}-${index}`} className="cmd-part">
            {part}
          </span>
        ))}
      </code>
      <button
        type="button"
        className={"copy" + (copied ? " ok" : "")}
        onClick={onCopy}
        disabled={!cmd}
        aria-label="Copy command"
      >
        {copied ? <Icons.Check size={11} /> : <Icons.Copy size={11} />}
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}

function browserServerUrl(): string {
  return window.location.origin.replace(/\/$/, "");
}

function pairServerAddress(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    if (url.protocol === "https:") return url.host;
  } catch {
    return serverUrl;
  }
  return serverUrl;
}

function readableDeviceName(): string {
  const adj = DEVICE_NAME_ADJECTIVES[Math.floor(Math.random() * DEVICE_NAME_ADJECTIVES.length)];
  const noun = DEVICE_NAME_NOUNS[Math.floor(Math.random() * DEVICE_NAME_NOUNS.length)];
  return `${adj} ${noun}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
