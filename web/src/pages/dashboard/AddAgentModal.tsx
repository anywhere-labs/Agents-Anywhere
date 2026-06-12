import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  api,
  type DeviceAgentsState,
  type RuntimeReport,
  type ScanRuntimeResponse,
} from "../../lib/api";
import { Icons } from "../../components/Icons";
import { runtimeAccent, runtimeLabel } from "../../lib/runtime";

type AddableRuntime = { id: string; placeholder: string };

// Runtimes the daemon can actually drive end-to-end. OpenCode / ACP show up
// elsewhere in the codebase but capabilities discovery doesn't support them
// yet, so we don't pretend we can scan for them.
const SCANNABLE_RUNTIMES: AddableRuntime[] = [
  { id: "codex", placeholder: "/usr/local/bin/codex" },
  { id: "claude", placeholder: "/usr/local/bin/claude" },
];

type AddAgentModalProps = {
  token: string;
  connectorId: string;
  currentCapabilities: DeviceAgentsState;
  onClose: () => void;
  onCapabilitiesChanged: (caps: DeviceAgentsState) => void;
};

type Phase =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "result"; outcome: ScanOutcome; runtime: string; report: RuntimeReport };

type ScanOutcome = "ok" | "missing" | "failed";

export function AddAgentModal({
  token,
  connectorId,
  currentCapabilities,
  onClose,
  onCapabilitiesChanged,
}: AddAgentModalProps) {
  // Runtimes already attached to this device get filtered out — those
  // already show in the Device page list with their own Delete button.
  // Previously-disabled runtimes ARE addable (Add is the user's path back
  // after a Delete), so we only care about `attached`.
  //
  // CRITICAL: snapshotted ONCE at mount. After a scan succeeds we call
  // `onCapabilitiesChanged` so the Device page updates in place — that
  // change propagates back into this modal's `currentCapabilities` prop.
  // If we recomputed `available` from the live prop the just-scanned
  // runtime would get filtered out mid-flow, killing the result chip and
  // either flipping the radio to a different runtime (inconsistent UI)
  // or rendering "all attached" (modal becomes unusable).
  const [snapshotAttachedIds] = useState<string[]>(() =>
    Object.keys(currentCapabilities?.attached ?? {}),
  );
  const available = useMemo(
    () => SCANNABLE_RUNTIMES.filter((r) => !snapshotAttachedIds.includes(r.id)),
    [snapshotAttachedIds],
  );

  const [runtime, setRuntime] = useState<string>(available[0]?.id ?? "");
  const [path, setPath] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [rpcError, setRpcError] = useState<string | null>(null);

  // ESC closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Cancel in-flight scan if the modal is torn down so the API result doesn't
  // call setState on an unmounted component.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const noneAddable = available.length === 0;

  const placeholder =
    available.find((r) => r.id === runtime)?.placeholder ?? "/path/to/agent";

  const doScan = async () => {
    if (!runtime) return;
    setRpcError(null);
    setPhase({ kind: "scanning" });
    try {
      const trimmed = path.trim();
      const res: ScanRuntimeResponse = await api.scanConnectorRuntime(
        token,
        connectorId,
        { runtime, path: trimmed || undefined },
      );
      if (cancelledRef.current) return;
      onCapabilitiesChanged(res.runtimeCapabilities);
      const outcome = deriveOutcome(runtime, res.scanned.report);
      setPhase({
        kind: "result",
        outcome,
        runtime: res.scanned.runtime,
        report: res.scanned.report,
      });
    } catch (err: unknown) {
      if (cancelledRef.current) return;
      const msg =
        err instanceof ApiError
          ? err.detail
          : err instanceof Error
            ? err.message
            : "Scan failed.";
      setRpcError(msg);
      setPhase({ kind: "idle" });
    }
  };

  const handlePrimary = () => {
    if (phase.kind === "result" && phase.outcome === "ok") {
      onClose();
      return;
    }
    void doScan();
  };

  const handleAddAnyway = () => {
    // capabilities are already stored as-is on the server; the Device page
    // will surface the failed status with a ? tooltip.
    onClose();
  };

  const primaryLabel =
    phase.kind === "scanning"
      ? "Scanning…"
      : phase.kind === "result" && phase.outcome === "ok"
        ? "Done"
        : "Scan agent";

  const primaryDisabled = phase.kind === "scanning" || !runtime;

  return (
    <div className="kl-modal-backdrop" onClick={onClose}>
      <div
        className="kl-modal kl-add-agent"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Add a new agent on this device"
      >
        <div className="kl-add-agent-hd">
          <h3>Add a new agent on this device</h3>
          <button
            type="button"
            className="x"
            onClick={onClose}
            aria-label="Close"
          >
            <Icons.X size={13} />
          </button>
        </div>
        <p className="kl-add-agent-hint">
          Pick a runtime your daemon should look for, or point it at a specific
          path.
        </p>

        {noneAddable ? (
          <div className="kl-add-agent-allset">
            All supported agents are already attached to this device.
          </div>
        ) : (
          <>
            <div className="kl-add-agent-section-label">Agent type</div>
            <div className="kl-add-agent-runtimes">
              {available.map((r) => (
                <label
                  key={r.id}
                  className={
                    "kl-add-agent-runtime" + (runtime === r.id ? " on" : "")
                  }
                >
                  <input
                    type="radio"
                    name="add-agent-runtime"
                    value={r.id}
                    checked={runtime === r.id}
                    onChange={() => setRuntime(r.id)}
                  />
                  <span
                    className="dot"
                    style={{ background: runtimeAccent(r.id) }}
                  />
                  <span className="label">{runtimeLabel(r.id)}</span>
                </label>
              ))}
            </div>

            <div className="kl-add-agent-section-label">
              Custom path <span className="muted">(optional)</span>
            </div>
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={placeholder}
              spellCheck={false}
            />

            {phase.kind === "result" && (
              <ResultChip
                outcome={phase.outcome}
                runtime={phase.runtime}
                report={phase.report}
              />
            )}

            {rpcError && (
              <div className="kl-add-agent-error">
                <span className="dot" />
                <span>{rpcError}</span>
              </div>
            )}
          </>
        )}

        <div className="kl-modal-actions">
          <button type="button" className="kl-btn ghost" onClick={onClose}>
            Cancel
          </button>
          {phase.kind === "result" && phase.outcome === "failed" && (
            <button
              type="button"
              className="kl-btn ghost"
              onClick={handleAddAnyway}
            >
              Add anyway
            </button>
          )}
          {!noneAddable && (
            <button
              type="button"
              className="kl-btn primary"
              onClick={handlePrimary}
              disabled={primaryDisabled}
            >
              {primaryLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function deriveOutcome(runtime: string, report: RuntimeReport): ScanOutcome {
  if (report.execution === "ok") return "ok";
  // For Claude, history-only is an acceptable signal too: even if the CLI is
  // missing we still surface the agent so the user can see its history. The
  // backend marks history "ok_empty" when the SDK session list is empty.
  if (
    runtime === "claude" &&
    (report.history === "ok" || report.history === "ok_empty") &&
    !report.error
  ) {
    return "ok";
  }
  const checked = report.checked ?? [];
  if (checked.length > 0 && checked.every((c) => c.status === "missing")) {
    return "missing";
  }
  return "failed";
}

function ResultChip({
  outcome,
  runtime,
  report,
}: {
  outcome: ScanOutcome;
  runtime: string;
  report: RuntimeReport;
}) {
  if (outcome === "ok") {
    const path = report.selected?.path ?? "(unknown path)";
    return (
      <div className="kl-add-agent-chip ok">
        <span className="dot" />
        <span>
          Found <b>{runtimeLabel(runtime)}</b> at <code>{path}</code>.
        </span>
      </div>
    );
  }
  if (outcome === "missing") {
    return (
      <div className="kl-add-agent-chip missing">
        <span className="dot" />
        <span>
          <MissingMessage runtime={runtime} />
        </span>
      </div>
    );
  }
  const reason =
    report.error?.message ??
    [...(report.checked ?? [])]
      .reverse()
      .find((c) => c.status === "failed")?.reason ??
    "check failed";
  return (
    <div className="kl-add-agent-chip failed">
      <span className="dot" />
      <span>
        Found something, but the check failed: <code>{reason}</code>
      </span>
    </div>
  );
}

// Per-runtime install guidance for the "missing" chip. Codex can be run
// either via the desktop app or the CLI, so we list both; Claude Code is
// CLI-only because we resume sessions through a PTY against the CLI even
// when the user opens them via the desktop app.
function MissingMessage({ runtime }: { runtime: string }) {
  if (runtime === "codex") {
    return (
      <>
        Couldn't find <b>{runtimeLabel(runtime)}</b>. Please install the
        Codex desktop app or the Codex CLI. The in-IDE Codex extension
        isn't supported.
      </>
    );
  }
  if (runtime === "claude") {
    return (
      <>
        Couldn't find <b>{runtimeLabel(runtime)}</b>. Install the Claude
        Code CLI — required even if you only use the Claude desktop app.
        The in-IDE ClaudeCode extension isn't supported.
      </>
    );
  }
  return (
    <>
      Couldn't find <b>{runtimeLabel(runtime)}</b>. Double-check the path
      and try again.
    </>
  );
}
