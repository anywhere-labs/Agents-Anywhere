import { useEffect, useMemo, useState } from "react";
import {
  ApiError,
  api,
  type AttachedAgent,
  type ConnectorRevokeResponse,
  type ConnectorView,
  type DeviceAgentsState,
  type RuntimeConfigSchema,
  type RuntimeSettingsResponse,
  type SessionView,
} from "../../lib/api";
import { Icons } from "../../components/Icons";
import { reportIsHealthy, runtimeAccent, runtimeLabel } from "../../lib/runtime";
import { ConfirmModal } from "./ConfirmModal";
import { AddAgentModal } from "./AddAgentModal";
import { RuntimeSettingsForm } from "./RuntimeSettingsForm";
import { RunModeGuide } from "./RunModeGuide";

type SessionFilter = "active" | "archived" | "all";

type DevicePageProps = {
  token: string;
  device: ConnectorView;
  sessions: SessionView[];
  onRename: (next: ConnectorView) => void;
  onDeleted: () => void;
  onTokenRotated: (credential: ConnectorRevokeResponse) => void;
  onPickSession: (sessionId: string) => void;
  onPickWorkspace: (cwd: string | null) => void;
  onNewSession: (cwd?: string | null) => void;
  onShowAllWorkspaces: () => void;
  // Called after Add → Scan or Delete returns new device-agents state. The
  // optional `deletedRuntime` tells the parent which runtime got detached
  // so it can also drop sessions for that runtime from its in-memory list
  // (the server already cascade-deleted them).
  onCapabilitiesChanged: (
    connectorId: string,
    caps: DeviceAgentsState,
    deletedRuntime?: string,
  ) => void;
  // Called after a bulk archive/unarchive so the parent merges the updated
  // SessionViews into its global list without waiting for the next poll.
  onSessionsPatched: (updated: SessionView[]) => void;
};

type AgentRow = {
  runtime: string;
  agent: AttachedAgent;
  healthy: boolean;
  // Reason text shown in the `?` tooltip when `healthy=false`. Derived
  // from the last failed `checked` entry, falling back to the error message.
  reason: string | null;
};

// Stable display order for the Agents list. Codex first, then Claude, then
// any future runtime alphabetically. Same rule as the Add modal so the user
// always sees the same ordering across the UI.
const RUNTIME_DISPLAY_ORDER = ["codex", "claude"];

export function DevicePage({
  token,
  device,
  sessions,
  onRename,
  onDeleted,
  onTokenRotated,
  onPickSession,
  onPickWorkspace,
  onNewSession,
  onShowAllWorkspaces,
  onCapabilitiesChanged,
  onSessionsPatched,
}: DevicePageProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>("active");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotateBusy, setRotateBusy] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);

  // Agents-section state — kept lean now that there's no Refresh button.
  const [addOpen, setAddOpen] = useState(false);
  const [confirmRuntime, setConfirmRuntime] = useState<string | null>(null);
  const [runModePromptOpen, setRunModePromptOpen] = useState(false);
  const [runtimeDeleteError, setRuntimeDeleteError] = useState<string | null>(
    null,
  );
  const [agentSettings, setAgentSettings] = useState<
    Record<string, RuntimeSettingsResponse | null>
  >({});
  const [agentSettingsError, setAgentSettingsError] = useState<
    Record<string, string | null>
  >({});
  const [agentSchemas, setAgentSchemas] = useState<
    Record<string, RuntimeConfigSchema | null>
  >({});

  // Bulk-archive state for the Sessions list.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);
  const [confirmArchiveAllOpen, setConfirmArchiveAllOpen] = useState(false);

  // Reset edit / modal state when the active device changes.
  useEffect(() => {
    setName(device.name);
    setEditing(false);
    setRenameError(null);
    setAddOpen(false);
    setConfirmRuntime(null);
    setRunModePromptOpen(false);
    setRuntimeDeleteError(null);
    setConfirmRotate(false);
    setRotateBusy(false);
    setRotateError(null);
    setAgentSettings({});
    setAgentSettingsError({});
    setAgentSchemas({});
    setSelectMode(false);
    setSelectedIds(new Set());
    setBulkMessage(null);
    setConfirmArchiveAllOpen(false);
  }, [device.id, device.name]);

  // Exiting select-mode whenever the tab switches keeps semantics simple:
  // a selected session that no longer matches the filter wouldn't be visible
  // anyway, so we just bail out and let the user re-select.
  useEffect(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, [sessionFilter]);

  const agentRows = useMemo(
    () => buildAgentRows(device.runtimeCapabilities),
    [device.runtimeCapabilities],
  );
  const hasClaudeAgent = agentRows.some((row) => row.runtime === "claude");
  const claudeSettingsResponse = agentSettings.claude;
  const showClaudeRunModePrompt =
    hasClaudeAgent && claudeSettingsResponse?.defaultRunModeConfigured === false;
  const claudeSettings = agentSettings.claude?.settings ?? null;
  const claudeSchema = agentSchemas.claude ?? null;
  const claudeSettingsError = agentSettingsError.claude ?? null;
  const agentRuntimeKey = useMemo(
    () => agentRows.map((row) => row.runtime).join("\n"),
    [agentRows],
  );

  useEffect(() => {
    let cancelled = false;
    const runtimes = agentRuntimeKey ? agentRuntimeKey.split("\n") : [];
    if (runtimes.length === 0) return undefined;
    setAgentSettings((prev) => {
      const next = { ...prev };
      for (const runtime of runtimes) {
        if (next[runtime] === undefined) next[runtime] = null;
      }
      return next;
    });
    for (const runtime of runtimes) {
      Promise.all([
        api.getConnectorAgentSettings(token, device.id, runtime),
        api.getRuntimeConfigSchema(token, runtime),
      ])
        .then(([settingsRes, schemaRes]) => {
          if (cancelled) return;
          setAgentSettings((prev) => ({ ...prev, [runtime]: settingsRes }));
          setAgentSchemas((prev) => ({ ...prev, [runtime]: schemaRes.schema }));
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const msg =
            err instanceof ApiError
              ? err.detail
              : err instanceof Error
                ? err.message
                : "Failed to load settings.";
          setAgentSettingsError((prev) => ({ ...prev, [runtime]: msg }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [agentRuntimeKey, device.id, token]);

  const patchAgentSettings = (runtime: string, settings: Record<string, unknown>) => {
    setAgentSettingsError((prev) => ({ ...prev, [runtime]: null }));
    api
      .patchConnectorAgentSettings(token, device.id, runtime, settings)
      .then((res) => {
        setAgentSettings((prev) => ({ ...prev, [runtime]: res }));
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof ApiError
            ? err.detail
            : err instanceof Error
              ? err.message
              : "Failed to save settings.";
        setAgentSettingsError((prev) => ({ ...prev, [runtime]: msg }));
      });
  };

  const deviceSessions = sessions
    .filter((s) => s.connectorId === device.id)
    .filter((s) =>
      sessionFilter === "active"
        ? !s.archived
        : sessionFilter === "archived"
          ? s.archived
          : true,
    );

  const workspaces = useMemo(() => {
    const groups = new Map<string, { cwd: string | null; sessions: SessionView[] }>();
    for (const s of sessions) {
      if (s.connectorId !== device.id) continue;
      const key = s.cwd || "(none)";
      const existing = groups.get(key);
      if (existing) existing.sessions.push(s);
      else groups.set(key, { cwd: s.cwd, sessions: [s] });
    }
    return Array.from(groups.values()).sort((a, b) => {
      const at = latestActivity(a.sessions);
      const bt = latestActivity(b.sessions);
      return bt.localeCompare(at);
    });
  }, [device.id, sessions]);
  const visibleWorkspaces = workspaces.slice(0, 8);
  const hiddenWorkspaceCount = Math.max(0, workspaces.length - visibleWorkspaces.length);

  const submitName = () => {
    const v = name.trim();
    if (!v || v === device.name) {
      setName(device.name);
      setEditing(false);
      setRenameError(null);
      return;
    }
    setRenameError(null);
    api
      .updateConnector(token, device.id, { name: v })
      .then((res) => {
        onRename(res.connector);
        setEditing(false);
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof ApiError
            ? err.detail
            : err instanceof Error
              ? err.message
              : "Failed to rename device.";
        setRenameError(msg);
        setName(device.name);
        setEditing(false);
      });
  };

  const doDelete = () => {
    setDeleteError(null);
    api
      .deleteConnector(token, device.id)
      .then(() => {
        setConfirmDelete(false);
        onDeleted();
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof ApiError
            ? err.detail
            : err instanceof Error
              ? err.message
              : "Failed to delete device.";
        setDeleteError(msg);
      });
  };

  const doReissueToken = () => {
    if (rotateBusy) return;
    setRotateBusy(true);
    setRotateError(null);
    api
      .revokeConnector(token, device.id)
      .then((res) => {
        setConfirmRotate(false);
        onRename(res.connector);
        onTokenRotated(res);
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof ApiError
            ? err.detail
              : err instanceof Error
                ? err.message
              : "Failed to prepare device setup.";
        setRotateError(msg);
      })
      .finally(() => setRotateBusy(false));
  };

  const doDeleteRuntime = () => {
    if (!confirmRuntime) return;
    const runtime = confirmRuntime;
    setRuntimeDeleteError(null);
    api
      .deleteConnectorRuntime(token, device.id, runtime)
      .then((res) => {
        onCapabilitiesChanged(device.id, res.runtimeCapabilities, runtime);
        setConfirmRuntime(null);
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof ApiError
            ? err.detail
            : err instanceof Error
              ? err.message
              : "Failed to remove agent.";
        setRuntimeDeleteError(msg);
      });
  };

  // When the user is on the All tab and has a mixed-archived selection, the
  // default action archives. Only when every selected row is already archived
  // do we flip the primary action to Unarchive — matches what you'd want on
  // the Archived tab.
  const targetArchivedForSelection = (() => {
    if (sessionFilter === "archived") return false;
    if (sessionFilter === "active") return true;
    if (selectedIds.size === 0) return true;
    for (const id of selectedIds) {
      const s = sessions.find((x) => x.id === id);
      if (s && !s.archived) return true;
    }
    return false;
  })();
  const targetArchivedForAll = sessionFilter !== "archived";
  const bulkActionLabel = targetArchivedForSelection
    ? "Archive selected"
    : "Unarchive selected";
  const archiveAllLabel = targetArchivedForAll
    ? "Archive all"
    : "Unarchive all";

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const toggleSelectId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const doBulkArchive = () => {
    if (bulkBusy || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    setBulkBusy(true);
    setBulkMessage(null);
    api
      .bulkArchiveSessions(token, ids, targetArchivedForSelection)
      .then((res) => {
        onSessionsPatched(res.sessions);
        exitSelectMode();
        const verb = targetArchivedForSelection ? "Archived" : "Unarchived";
        const skipped = res.notFound.length;
        setBulkMessage({
          kind: skipped > 0 ? "err" : "ok",
          text:
            `${verb} ${res.sessions.length} session${res.sessions.length === 1 ? "" : "s"}` +
            (skipped > 0 ? ` · ${skipped} skipped` : ""),
        });
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof ApiError
            ? err.detail
            : err instanceof Error
              ? err.message
              : "Failed to update sessions.";
        setBulkMessage({ kind: "err", text: msg });
      })
      .finally(() => setBulkBusy(false));
  };

  const doArchiveAll = () => {
    if (bulkBusy) return;
    setBulkBusy(true);
    setBulkMessage(null);
    api
      .archiveAllDeviceSessions(
        token,
        device.id,
        targetArchivedForAll,
        sessionFilter,
      )
      .then((res) => {
        onSessionsPatched(res.sessions);
        setConfirmArchiveAllOpen(false);
        exitSelectMode();
        const verb = targetArchivedForAll ? "Archived" : "Unarchived";
        setBulkMessage({
          kind: "ok",
          text: `${verb} ${res.affected} session${res.affected === 1 ? "" : "s"}.`,
        });
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof ApiError
            ? err.detail
            : err instanceof Error
              ? err.message
              : "Failed to archive sessions.";
        setBulkMessage({ kind: "err", text: msg });
      })
      .finally(() => setBulkBusy(false));
  };

  const offline = device.status !== "online";
  const tokenActionLabel = offline ? "Setup" : "Revoke";
  const tokenActionTitle = offline
    ? "Generate a new setup token"
    : "Revoke connector token";

  return (
    <div className="kl-dev-page">
      <div className="kl-dev-page-inner">
        <div className="kl-dev-hd">
          {editing ? (
            <input
              className="name-edit"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={submitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitName();
                if (e.key === "Escape") {
                  setName(device.name);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="name"
              onClick={() => setEditing(true)}
              title="Click to rename"
            >
              {device.name}
            </button>
          )}
          <span className={"status " + device.status}>
            {device.status === "online" ? "online" : "offline"}
          </span>
          <button
            type="button"
            className="delete"
            onClick={() => setConfirmRotate(true)}
            title={tokenActionTitle}
            aria-label={tokenActionTitle}
          >
            <Icons.Key size={13} />
            <span>{tokenActionLabel}</span>
          </button>
          <button
            type="button"
            className="delete icon-only"
            onClick={() => setConfirmDelete(true)}
            title="Delete device"
            aria-label="Delete device"
          >
            <Icons.Trash size={13} />
          </button>
        </div>

        {renameError && (
          <div
            className="kl-dev-banner"
            style={{ marginTop: -12, color: "oklch(0.72 0.16 25)" }}
          >
            <span className="dot" />
            <span>{renameError}</span>
          </div>
        )}

        {showClaudeRunModePrompt && (
          <div className="kl-runmode-alert kl-dev-runmode-alert" role="alert">
            <Icons.AlertCircle size={15} />
            <div className="kl-runmode-alert-copy">
              <strong>Set your default Claude Code run mode</strong>
              <span>
                This can affect whether Claude Code uses API/relay billing or
                your local Claude Code login.
              </span>
            </div>
            <button type="button" onClick={() => setRunModePromptOpen(true)}>
              Choose mode
            </button>
          </div>
        )}

        {device.status === "offline" && (
          <div className="kl-dev-banner">
            <span className="dot" />
            <span>
              This device is offline. Make sure the machine is on and{" "}
              <b>Agents Anywhere Daemon</b> is running on it.
            </span>
          </div>
        )}

        {rotateError && (
          <div
            className="kl-dev-banner"
            style={{ color: "oklch(0.72 0.16 25)" }}
          >
            <span className="dot" />
            <span>{rotateError}</span>
          </div>
        )}

        <div className="kl-dev-section">
          <div className="kl-dev-sechd">
            <h4>Agents</h4>
            <div className="kl-dev-sechd-actions">
              <button
                type="button"
                className="kl-icon-btn add icon-only"
                onClick={() => setAddOpen(true)}
                disabled={offline}
                title={offline ? "Device is offline" : "Add an agent"}
                aria-label="Add agent"
              >
                <Icons.Plus size={13} />
              </button>
            </div>
          </div>
          <div className="kl-dev-list">
            {agentRows.length === 0 ? (
              <div className="kl-dev-empty">
                {offline
                  ? "Bring the device online to manage agents."
                  : "No agents attached to this device yet. Click + Add to scan one."}
              </div>
            ) : (
              agentRows.map((row) => (
                <AgentRowView
                  key={row.runtime}
                  row={row}
                  settings={agentSettings[row.runtime]?.settings ?? null}
                  schema={agentSchemas[row.runtime] ?? null}
                  settingsError={agentSettingsError[row.runtime] ?? null}
                  onPatchSettings={(settings) =>
                    patchAgentSettings(row.runtime, settings)
                  }
                  onDelete={() => {
                    setRuntimeDeleteError(null);
                    setConfirmRuntime(row.runtime);
                  }}
                />
              ))
            )}
          </div>
        </div>

        <div className="kl-dev-section">
          <div className="kl-dev-sechd">
            <h4>Workspaces</h4>
            <div className="kl-dev-sechd-actions">
              <button
                type="button"
                className="kl-icon-btn add icon-only"
                onClick={() => onNewSession(null)}
                disabled={offline || agentRows.length === 0}
                title={
                  offline
                    ? "Device is offline"
                    : agentRows.length === 0
                      ? "Add an agent first"
                      : "Start a session"
                }
                aria-label="New session"
              >
                <Icons.Plus size={13} />
              </button>
            </div>
          </div>
          <div className="kl-workspace-grid">
            {workspaces.length === 0 ? (
              <div className="kl-dev-empty">
                No workspaces yet. Start a session to create one.
              </div>
            ) : (
              visibleWorkspaces.map((ws) => {
                return (
                  <div key={ws.cwd || "(none)"} className="kl-workspace-card">
                    <button
                      type="button"
                      className="kl-workspace-main"
                      onClick={() => onPickWorkspace(ws.cwd)}
                    >
                      <span className="ico">
                        <Icons.FolderOpen size={15} />
                      </span>
                      <span className="title">{workspaceLabel(ws.cwd)}</span>
                      <span className="meta">
                        {ws.sessions.length} session
                        {ws.sessions.length === 1 ? "" : "s"}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="kl-icon-btn icon-only"
                      onClick={() => onNewSession(ws.cwd)}
                      disabled={offline || agentRows.length === 0 || !ws.cwd}
                      title="New session in this workspace"
                      aria-label="New session in this workspace"
                    >
                      <Icons.Plus size={13} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
          {hiddenWorkspaceCount > 0 && (
            <button
              type="button"
              className="kl-workspace-show-all"
              onClick={onShowAllWorkspaces}
            >
              Show all
              <span>{hiddenWorkspaceCount} more</span>
              <Icons.ChevRight size={13} />
            </button>
          )}
        </div>

        <div className="kl-dev-section">
          <div className="kl-dev-sechd">
            <h4>Sessions</h4>
            <div className="kl-dev-sechd-actions">
              {selectMode ? (
                <button
                  type="button"
                  className="kl-icon-btn"
                  onClick={exitSelectMode}
                  disabled={bulkBusy}
                >
                  <span>Cancel</span>
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="kl-icon-btn"
                    onClick={() => {
                      setSelectMode(true);
                      setBulkMessage(null);
                    }}
                    disabled={deviceSessions.length === 0}
                    title={
                      deviceSessions.length === 0
                        ? "No sessions to select"
                        : "Select multiple to archive"
                    }
                  >
                    <Icons.Check size={13} />
                    <span>Select</span>
                  </button>
                  <button
                    type="button"
                    className="kl-icon-btn"
                    onClick={() => {
                      setBulkMessage(null);
                      setConfirmArchiveAllOpen(true);
                    }}
                    disabled={deviceSessions.length === 0 || bulkBusy}
                    title={
                      deviceSessions.length === 0
                        ? "No sessions on this device"
                        : `${archiveAllLabel} on this device`
                    }
                  >
                    <span>{archiveAllLabel}</span>
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="kl-dev-tabs">
            {(["active", "archived", "all"] as SessionFilter[]).map((k) => (
              <button
                key={k}
                type="button"
                className={"kl-dev-tab" + (sessionFilter === k ? " on" : "")}
                onClick={() => setSessionFilter(k)}
              >
                {k[0].toUpperCase() + k.slice(1)}
              </button>
            ))}
          </div>
          {selectMode && (
            <div className="kl-dev-bulkbar">
              <label className="kl-dev-bulkbar-all">
                <input
                  type="checkbox"
                  checked={
                    deviceSessions.length > 0 &&
                    deviceSessions.every((s) => selectedIds.has(s.id))
                  }
                  ref={(el) => {
                    if (el) {
                      const some = deviceSessions.some((s) =>
                        selectedIds.has(s.id),
                      );
                      const all =
                        deviceSessions.length > 0 &&
                        deviceSessions.every((s) => selectedIds.has(s.id));
                      el.indeterminate = some && !all;
                    }
                  }}
                  onChange={(e) => {
                    if (e.target.checked)
                      setSelectedIds(new Set(deviceSessions.map((s) => s.id)));
                    else setSelectedIds(new Set());
                  }}
                  disabled={bulkBusy || deviceSessions.length === 0}
                />
                <span>Select all</span>
              </label>
              <span className="kl-dev-bulkbar-count">
                {selectedIds.size} selected
              </span>
              <button
                type="button"
                className="kl-btn primary"
                onClick={doBulkArchive}
                disabled={bulkBusy || selectedIds.size === 0}
              >
                {bulkBusy ? "Working…" : bulkActionLabel}
              </button>
            </div>
          )}
          {bulkMessage && (
            <div
              className="kl-dev-banner"
              style={{
                color:
                  bulkMessage.kind === "err"
                    ? "oklch(0.72 0.16 25)"
                    : undefined,
              }}
            >
              <span className="dot" />
              <span>{bulkMessage.text}</span>
            </div>
          )}
          <div className="kl-dev-list">
            {deviceSessions.length === 0 ? (
              <div className="kl-dev-empty">
                {sessionFilter === "archived"
                  ? "No archived sessions."
                  : sessionFilter === "active"
                    ? "No active sessions on this device."
                    : "No sessions on this device."}
              </div>
            ) : (
              deviceSessions.map((s) => {
                const selected = selectedIds.has(s.id);
                if (selectMode) {
                  return (
                    <label
                      key={s.id}
                      className={
                        "kl-dev-item kl-dev-item-select" +
                        (selected ? " selected" : "")
                      }
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleSelectId(s.id)}
                        disabled={bulkBusy}
                      />
                      <span className="ico">
                        <Icons.List size={14} />
                      </span>
                      <span className="title">
                        {s.title || "Untitled session"}
                      </span>
                      <span className="time">
                        {formatRelative(
                          s.lastActivityAt || s.lastItemAt || null,
                        )}
                      </span>
                    </label>
                  );
                }
                return (
                  <button
                    key={s.id}
                    type="button"
                    className="kl-dev-item link"
                    onClick={() => onPickSession(s.id)}
                  >
                    <span className="ico">
                      <Icons.List size={14} />
                    </span>
                    <span className="title">
                      {s.title || "Untitled session"}
                    </span>
                    <span className="time">
                      {formatRelative(s.lastActivityAt || s.lastItemAt || null)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      {addOpen && (
        <AddAgentModal
          token={token}
          connectorId={device.id}
          currentCapabilities={device.runtimeCapabilities}
          onClose={() => setAddOpen(false)}
          onCapabilitiesChanged={(caps) =>
            onCapabilitiesChanged(device.id, caps)
          }
        />
      )}

      {confirmRuntime && (
        <ConfirmModal
          title={`Remove ${runtimeLabel(confirmRuntime)} from this device?`}
          body={
            `Removing ${runtimeLabel(confirmRuntime)} only forgets it on ` +
            `the server — your local install on this machine is untouched. ` +
            `All chat sessions for ${runtimeLabel(confirmRuntime)} on this ` +
            `device will be permanently removed. To bring ${runtimeLabel(confirmRuntime)} ` +
            `back later, click + Add above.`
          }
          confirmLabel={runtimeDeleteError ? "Retry remove" : "Remove agent"}
          danger
          onCancel={() => {
            setConfirmRuntime(null);
            setRuntimeDeleteError(null);
          }}
          onConfirm={doDeleteRuntime}
        />
      )}

      {confirmRotate && (
        <ConfirmModal
          title={offline ? "Set up this device again?" : "Revoke this device token?"}
          body={
            offline
              ? `Generate a new setup command for ${device.name}. The previous connector token will stop working.`
              : `The current connector token for ${device.name} will stop working ` +
                `and the device will be disconnected until you run the new setup command.`
          }
          confirmLabel={
            rotateBusy
              ? offline
                ? "Preparing..."
                : "Revoking..."
              : tokenActionLabel
          }
          danger={!offline}
          onConfirm={doReissueToken}
          onCancel={() => {
            if (!rotateBusy) setConfirmRotate(false);
          }}
        />
      )}
      {confirmRuntime && runtimeDeleteError && (
        <div
          className="kl-dev-banner"
          style={{ position: "fixed", bottom: 16, right: 16, zIndex: 1100 }}
        >
          <span className="dot" />
          <span>{runtimeDeleteError}</span>
        </div>
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete this device?"
          body={
            "This removes the device and deletes all server records tied to it, " +
            "including its sessions, workspaces, attached agents, runtime settings, " +
            "and connector token. To bring it back you'll need to pair it again."
          }
          confirmLabel={deleteError ? "Retry delete" : "Delete"}
          danger
          onCancel={() => {
            setConfirmDelete(false);
            setDeleteError(null);
          }}
          onConfirm={doDelete}
        />
      )}
      {confirmDelete && deleteError && (
        <div
          className="kl-dev-banner"
          style={{ position: "fixed", bottom: 16, right: 16, zIndex: 1100 }}
        >
          <span className="dot" />
          <span>{deleteError}</span>
        </div>
      )}
      {runModePromptOpen && (
        <RuntimeConfigModal
          runtime="claude"
          schema={claudeSchema}
          settings={claudeSettings}
          settingsError={claudeSettingsError}
          initialView="runModeGuide"
          onClose={() => setRunModePromptOpen(false)}
          onPatchSettings={(settings) => patchAgentSettings("claude", settings)}
        />
      )}
      {confirmArchiveAllOpen &&
        (() => {
          const verb = targetArchivedForAll ? "Archive" : "Unarchive";
          const scopeLabel =
            sessionFilter === "all"
              ? "all sessions"
              : sessionFilter === "archived"
                ? "all archived sessions"
                : "all active sessions";
          return (
            <ConfirmModal
              title={`${verb} ${scopeLabel} on this device?`}
              body={
                targetArchivedForAll
                  ? `Every ${sessionFilter === "all" ? "" : sessionFilter + " "}session on ${device.name} will be moved to the Archived tab. You can unarchive them later.`
                  : `Every archived session on ${device.name} will move back to Active.`
              }
              confirmLabel={bulkBusy ? "Working…" : `${verb} all`}
              onCancel={() => {
                if (bulkBusy) return;
                setConfirmArchiveAllOpen(false);
              }}
              onConfirm={doArchiveAll}
            />
          );
        })()}
    </div>
  );
}

function AgentRowView({
  row,
  settings,
  schema,
  settingsError,
  onPatchSettings,
  onDelete,
}: {
  row: AgentRow;
  settings: Record<string, unknown> | null;
  schema: RuntimeConfigSchema | null;
  settingsError: string | null;
  onPatchSettings: (settings: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const [configOpen, setConfigOpen] = useState(false);
  const runMode =
    row.runtime === "claude" && settings?.runMode === "terminal"
      ? "terminal"
      : "chat";
  return (
    <div className="kl-dev-agent-card">
      <div className="kl-dev-item kl-dev-agent-row">
        <span className="ico">
          <span
            className="dot"
            style={{
              background: runtimeAccent(row.runtime),
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
            }}
          />
        </span>
        <span className="title">{runtimeLabel(row.runtime)}</span>
        {row.runtime === "claude" && settings && (
          <span className="kl-dev-agent-chip">
            {runMode === "terminal" ? "Terminal mode" : "Chat mode"}
          </span>
        )}
        {!row.healthy && row.reason && (
          <span
            className="kl-dev-agent-warn"
            title={row.reason}
            aria-label={`Warning: ${row.reason}`}
          >
            <Icons.AlertCircle size={13} />
            <span className="tooltip">{row.reason}</span>
          </span>
        )}
        <div className="kl-dev-agent-actions">
          <button
            type="button"
            className="kl-dev-agent-config-btn"
            onClick={() => setConfigOpen(true)}
            aria-label={`Configure ${runtimeLabel(row.runtime)}`}
            title={`Configure ${runtimeLabel(row.runtime)}`}
          >
            <Icons.Settings size={12} />
          </button>
          <button
            type="button"
            className="kl-dev-agent-del"
            onClick={onDelete}
            title="Remove agent (server-side only)"
            aria-label="Remove agent"
          >
            <Icons.Trash size={12} />
          </button>
        </div>
      </div>
      {configOpen && (
        <RuntimeConfigModal
          runtime={row.runtime}
          schema={schema}
          settings={settings}
          settingsError={settingsError}
          onClose={() => setConfigOpen(false)}
          onPatchSettings={onPatchSettings}
        />
      )}
    </div>
  );
}

function RuntimeConfigModal({
  runtime,
  schema,
  settings,
  settingsError,
  initialView = "settings",
  onClose,
  onPatchSettings,
}: {
  runtime: string;
  schema: RuntimeConfigSchema | null;
  settings: Record<string, unknown> | null;
  settingsError: string | null;
  initialView?: "settings" | "runModeGuide";
  onClose: () => void;
  onPatchSettings: (settings: Record<string, unknown>) => void;
}) {
  const [view, setView] = useState<"settings" | "runModeGuide">(initialView);
  const savedRunMode = settings?.runMode === "terminal" ? "terminal" : "chat";
  const [draftRunMode, setDraftRunMode] = useState<"chat" | "terminal">(
    savedRunMode,
  );
  const isRunModeGuide = runtime === "claude" && view === "runModeGuide";
  useEffect(() => {
    setDraftRunMode(savedRunMode);
  }, [savedRunMode, isRunModeGuide]);

  const handleDoneRunMode = () => {
    if (settings && draftRunMode !== savedRunMode) {
      onPatchSettings({ runMode: draftRunMode });
    }
    if (initialView === "runModeGuide") {
      onClose();
    } else {
      setView("settings");
    }
  };

  return (
    <div className="kl-modal-backdrop" onClick={onClose}>
      <div
        className={
          isRunModeGuide
            ? "kl-modal kl-runtime-config-modal guide-open"
            : "kl-modal kl-runtime-config-modal"
        }
        role="dialog"
        aria-label={`${runtimeLabel(runtime)} configuration`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="kl-runtime-config-viewport">
          <div
            className={
              isRunModeGuide
                ? "kl-runtime-config-pages show-guide"
                : "kl-runtime-config-pages"
            }
          >
            <div className="kl-runtime-config-page">
              <div className="kl-runtime-config-hd">
                <div>
                  <h3>{runtimeLabel(runtime)}</h3>
                  <span>Default configuration</span>
                </div>
                <button type="button" onClick={onClose} aria-label="Close">
                  <Icons.X size={14} />
                </button>
              </div>
              <RuntimeSettingsForm
                runtime={runtime}
                schema={schema}
                settings={settings}
                scope="device"
                className="kl-dev-agent-settings kl-runtime-settings-form"
                disabled={!settings}
                onExplainRunMode={
                  runtime === "claude" ? () => setView("runModeGuide") : undefined
                }
                onPatch={onPatchSettings}
              />
              {settingsError && (
                <div className="kl-dev-agent-error">{settingsError}</div>
              )}
              <div className="kl-modal-actions">
                <button type="button" className="kl-btn ghost" onClick={onClose}>
                  Save
                </button>
              </div>
            </div>
            <div className="kl-runtime-config-page">
              <RunModeGuide
                value={draftRunMode}
                disabled={!settings}
                showBack={initialView !== "runModeGuide"}
                onBack={() => setView("settings")}
                onClose={onClose}
                onDone={handleDoneRunMode}
                onSelect={setDraftRunMode}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Convert the per-device agents state into the row models the UI renders.
// All "is this agent attached?" reasoning is gone — `attached` is the
// explicit list. We only have to decide whether to show each as healthy
// (green dot) or warning (`?` icon + tooltip).
export function buildAgentRows(state: DeviceAgentsState | undefined): AgentRow[] {
  const attached = state?.attached ?? {};
  const rows: AgentRow[] = [];
  for (const [runtime, agent] of Object.entries(attached)) {
    if (!agent || typeof agent !== "object") continue;
    const healthy = reportIsHealthy(agent.report);
    let reason: string | null = null;
    if (!healthy) {
      const checked = agent.report?.checked ?? [];
      reason =
        [...checked].reverse().find((c) => c.status === "failed")?.reason ??
        agent.report?.error?.message ??
        "Local check did not pass.";
    }
    rows.push({ runtime, agent, healthy, reason });
  }
  rows.sort((a, b) => {
    const ai = RUNTIME_DISPLAY_ORDER.indexOf(a.runtime);
    const bi = RUNTIME_DISPLAY_ORDER.indexOf(b.runtime);
    if (ai !== -1 || bi !== -1) {
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    }
    return a.runtime.localeCompare(b.runtime);
  });
  return rows;
}

function latestActivity(items: SessionView[]): string {
  return items.reduce((best, s) => {
    const value = s.lastActivityAt || s.lastItemAt || s.sortAt || "";
    return value > best ? value : best;
  }, "");
}

function workspaceLabel(cwd: string | null): string {
  if (!cwd) return "(none)";
  const trimmed = cwd.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) || cwd;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h`;
  const day = Math.round(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day} d`;
  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk} w`;
  const mo = Math.round(day / 30);
  return `${mo} mo`;
}
