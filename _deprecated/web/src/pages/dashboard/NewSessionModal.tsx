import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  api,
  type ConnectorView,
  type FsEntry,
  type SessionView,
} from "../../lib/api";
import { Icons } from "../../components/Icons";
import { reportIsHealthy, runtimeLabel } from "../../lib/runtime";

type NewSessionModalProps = {
  token: string;
  connectors: ConnectorView[];
  sessions: SessionView[];
  preferredConnectorId?: string | null;
  initialCwd?: string | null;
  onCancel: () => void;
  onCreated: (session: SessionView) => void;
};

export function NewSessionModal({
  token,
  connectors,
  sessions,
  preferredConnectorId,
  initialCwd = null,
  onCancel,
  onCreated,
}: NewSessionModalProps) {
  const online = useMemo(
    () =>
      connectors.filter(
        (c) => c.status === "online" && attachedRuntimes(c).length > 0,
      ),
    [connectors],
  );
  const initialConnector =
    online.find((c) => c.id === preferredConnectorId) ?? online[0] ?? null;

  const [connectorId, setConnectorId] = useState(initialConnector?.id ?? "");
  const connector =
    online.find((c) => c.id === connectorId) ?? initialConnector ?? null;
  const runtimes = connector ? attachedRuntimes(connector) : [];

  const [runtime, setRuntime] = useState(runtimes[0]?.runtime ?? "codex");
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState(
    initialCwd || (connector ? defaultCwd(connector.id, sessions) : "~"),
  );
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [currentPath, setCurrentPath] = useState(
    initialCwd || (connector ? defaultCwd(connector.id, sessions) : "~"),
  );
  const [fsLoading, setFsLoading] = useState(false);
  const [fsError, setFsError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const lastResetConnectorIdRef = useRef<string | null>(null);

  const loadDir = useCallback(
    async (nextPath: string) => {
      if (!connector) return;
      const target = nextPath.trim() || "~";
      setFsLoading(true);
      setFsError(null);
      try {
        const res = await api.connectorFsList(token, connector.id, {
          root: target,
          path: ".",
        });
        const resolved = res.result.path || target;
        setEntries(res.result.entries || []);
        setCurrentPath(resolved);
        setCwd(resolved);
      } catch (err: unknown) {
        const message =
          err instanceof ApiError
            ? err.detail
            : err instanceof Error
              ? err.message
              : "Failed to list directory.";
        setEntries([]);
        setFsError(message);
      } finally {
        setFsLoading(false);
      }
    },
    [connector, token],
  );

  useEffect(() => {
    if (!connector) return;
    const rs = attachedRuntimes(connector);
    setRuntime((prev) =>
      rs.some((r) => r.runtime === prev) ? prev : rs[0]?.runtime || "codex",
    );
  }, [connector]);

  useEffect(() => {
    if (!connector) return;
    if (lastResetConnectorIdRef.current === connector.id) return;
    lastResetConnectorIdRef.current = connector.id;
    const nextPath = initialCwd || defaultCwd(connector.id, sessions);
    setCwd(nextPath);
    setCurrentPath(nextPath);
    setEntries([]);
    setFsError(null);
    void loadDir(nextPath);
  }, [connector, initialCwd, loadDir, sessions]);

  const parent = useMemo(() => parentPath(currentPath || cwd), [currentPath, cwd]);
  const sortedEntries = useMemo(
    () =>
      entries.slice().sort((a, b) => {
        if (a.type === "directory" && b.type !== "directory") return -1;
        if (a.type !== "directory" && b.type === "directory") return 1;
        return a.name.localeCompare(b.name);
      }),
    [entries],
  );

  const create = () => {
    if (!connector || !runtime || creating) return;
    setCreating(true);
    setCreateError(null);
    api
      .createSession(token, {
        connectorId: connector.id,
        runtime,
        title: title.trim() || undefined,
        cwd: cwd.trim() || undefined,
      })
      .then((res) => {
        onCreated(res.session);
      })
      .catch((err: unknown) => {
        const message =
          err instanceof ApiError
            ? err.detail
            : err instanceof Error
              ? err.message
              : "Failed to create session.";
        setCreateError(message);
      })
      .finally(() => setCreating(false));
  };

  return (
    <div className="kl-modal-backdrop" onClick={onCancel}>
      <div
        className="kl-modal kl-new-session"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="New session"
      >
        <div className="kl-pair-hd">
          <h3>New session</h3>
          <button
            type="button"
            className="x"
            onClick={onCancel}
            aria-label="Close"
          >
            <Icons.X size={13} />
          </button>
        </div>

        <div className="kl-new-session-grid">
          <label className="kl-form-row">
            <span>Device</span>
            <select
              value={connector?.id ?? ""}
              onChange={(e) => setConnectorId(e.target.value)}
            >
              {online.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="kl-form-row">
            <span>Agent</span>
            <select value={runtime} onChange={(e) => setRuntime(e.target.value)}>
              {runtimes.map((row) => (
                <option key={row.runtime} value={row.runtime}>
                  {runtimeLabel(row.runtime)}
                  {row.healthy ? "" : " (check failed)"}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="kl-form-row">
          <span>Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Optional"
          />
        </label>

        <label className="kl-form-row">
          <span>Workspace path</span>
          <div className="kl-path-input">
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void loadDir(cwd);
              }}
              placeholder="~/code/project"
            />
            <button
              type="button"
              className="kl-icon-btn"
              onClick={() => parent && void loadDir(parent)}
              disabled={fsLoading || !parent}
              title="Parent directory"
            >
              <Icons.ChevUp size={13} />
            </button>
            <button
              type="button"
              className="kl-icon-btn"
              onClick={() => void loadDir(cwd)}
              disabled={fsLoading || !cwd.trim()}
              title="Open path"
            >
              {fsLoading ? <Icons.Loader size={13} /> : <Icons.ChevRight size={13} />}
            </button>
          </div>
        </label>

        <div className="kl-dir-browser">
          <div className="kl-dir-browser-hd">
            <span>{currentPath || cwd || "Directory"}</span>
            <span>{fsLoading ? "loading..." : `${entries.length} items`}</span>
          </div>
          <div className="kl-dir-list">
            {fsError ? (
              <div className="kl-dev-empty error">{fsError}</div>
            ) : (
              <>
                {parent && (
                  <button
                    type="button"
                    className="kl-dev-item link"
                    onClick={() => void loadDir(parent)}
                  >
                    <span className="ico">
                      <Icons.FolderOpen size={14} />
                    </span>
                    <span className="title">..</span>
                    <span className="meta">parent</span>
                  </button>
                )}
                {sortedEntries.length === 0 ? (
              <div className="kl-dev-empty">
                    {fsLoading ? "Listing directory..." : "This directory is empty."}
              </div>
                ) : (
                  sortedEntries.slice(0, 120).map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className="kl-dev-item link"
                      onClick={() => {
                        if (entry.type === "directory") void loadDir(entry.path);
                      }}
                      disabled={entry.type !== "directory"}
                >
                  <span className="ico">
                        {entry.type === "directory" ? (
                          <Icons.Folder size={14} />
                        ) : (
                          <Icons.File size={14} />
                        )}
                  </span>
                  <span className="title">{entry.name}</span>
                      <span className="meta">
                        {entry.type === "file" && typeof entry.size === "number"
                          ? formatBytes(entry.size)
                          : entry.type}
                      </span>
                </button>
                  ))
                )}
              </>
            )}
          </div>
        </div>

        {createError && <p className="kl-pair-error">{createError}</p>}
        <div className="kl-pair-actions">
          <button type="button" className="kl-btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="kl-btn primary"
            onClick={create}
            disabled={!connector || !runtime || creating}
          >
            {creating ? "Creating..." : "Create session"}
          </button>
        </div>
      </div>
    </div>
  );
}

function attachedRuntimes(connector: ConnectorView) {
  return Object.entries(connector.runtimeCapabilities.attached)
    .map(([runtime, agent]) => ({
      runtime,
      healthy: reportIsHealthy(agent.report),
    }))
    .sort((a, b) => a.runtime.localeCompare(b.runtime));
}

function defaultCwd(connectorId: string, sessions: SessionView[]): string {
  const existing = sessions.find(
    (s) => s.connectorId === connectorId && !!s.cwd,
  )?.cwd;
  return existing || "~";
}

function parentPath(path: string): string {
  const clean = path.trim().replace(/[/\\]+$/, "") || ".";
  if (clean === "." || clean === "/" || /^[A-Za-z]:[\\/]?$/.test(clean)) return "";
  const normalized = clean.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return ".";
  if (slash === 0) return "/";
  return normalized.slice(0, slash);
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
