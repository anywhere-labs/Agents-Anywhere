import { useEffect, useMemo, useState } from "react";
import { Icons } from "../../components/Icons";
import type { ConnectorView, SessionView } from "../../lib/api";
import { FilePreviewPanel } from "./session-detail/runtime/FilePreviewPanel";
import { FilesPanel, type PickedFile } from "./session-detail/runtime/FilesPanel";
import { RuntimeWindow } from "./session-detail/runtime/RuntimeWindow";
import { TerminalPanel } from "./session-detail/runtime/TerminalPanel";
import { makeRuntimeApi } from "./session-detail/runtime/runtimeApi";
import "./session-detail/runtime/runtime.css";

type WorkspacePageProps = {
  token: string;
  device: ConnectorView;
  sessions: SessionView[];
  initialWorkspaceCwd?: string | null;
  onBack: () => void;
  onNewSession: (cwd?: string | null) => void;
};

type WorkspaceGroup = {
  key: string;
  cwd: string | null;
  sessions: SessionView[];
  latest: SessionView;
};

export function WorkspacePage({
  token,
  device,
  sessions,
  initialWorkspaceCwd,
  onBack,
  onNewSession,
}: WorkspacePageProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<PickedFile | null>(null);
  const [popped, setPopped] = useState({
    shell: false,
    files: false,
    preview: false,
  });

  const workspaces = useMemo(
    () => buildWorkspaces(device.id, sessions),
    [device.id, sessions],
  );

  useEffect(() => {
    const requestedKey = workspaceKeyFromCwd(initialWorkspaceCwd);
    if (requestedKey && workspaces.some((ws) => ws.key === requestedKey)) {
      if (selectedKey !== requestedKey) {
        setSelectedKey(requestedKey);
        setActiveFile(null);
      }
      return;
    }
    if (selectedKey && workspaces.some((ws) => ws.key === selectedKey)) return;
    setSelectedKey(workspaces[0]?.key ?? null);
    setActiveFile(null);
  }, [initialWorkspaceCwd, selectedKey, workspaces]);

  const selected =
    workspaces.find((ws) => ws.key === selectedKey) ?? workspaces[0] ?? null;
  const runtimeApi = useMemo(
    () =>
      selected
        ? makeRuntimeApi({
            sessionId: selected.latest.id,
            connectorId: device.id,
            root: selected.cwd,
            token,
          })
        : null,
    [device.id, selected?.cwd, selected?.latest.id, token],
  );
  const offline = device.status !== "online";
  const shellPanel = runtimeApi ? (
    <TerminalPanel
      api={runtimeApi}
      onClose={() => setPopped((prev) => ({ ...prev, shell: false }))}
      showClose={popped.shell}
      title="Shell"
      onPopOut={popped.shell ? undefined : () => setPopped((prev) => ({ ...prev, shell: true }))}
    />
  ) : (
    <div className="kl-ws-empty">Select a workspace</div>
  );
  const filesPanel = runtimeApi ? (
    <FilesPanel
      api={runtimeApi}
      onClose={() => setPopped((prev) => ({ ...prev, files: false }))}
      onPickFile={(file) => {
        setActiveFile(file);
        setPopped((prev) => ({ ...prev, preview: true }));
      }}
      activeFile={activeFile}
      showClose={popped.files}
      onPopOut={popped.files ? undefined : () => setPopped((prev) => ({ ...prev, files: true }))}
    />
  ) : (
    <div className="kl-ws-empty">Select a workspace</div>
  );

  const pageClass =
    "kl-ws-page" +
    (popped.shell ? " no-shell" : "") +
    (popped.files ? " no-files" : "");

  return (
    <div className={pageClass}>
      <aside className="kl-ws-list-pane">
        <div className="kl-ws-head">
          <button
            type="button"
            className="kl-iconbtn"
            onClick={onBack}
            title="Back to device"
            aria-label="Back to device"
          >
            <Icons.ChevRight
              size={15}
              style={{ transform: "rotate(180deg)" }}
            />
          </button>
          <div className="kl-ws-title">
            <span>{device.name}</span>
            <small>Workspaces</small>
          </div>
          <button
            type="button"
            className="kl-iconbtn"
            onClick={() => onNewSession(null)}
            disabled={offline}
            title={offline ? "Device is offline" : "New session"}
            aria-label="New session"
          >
            <Icons.Plus size={15} />
          </button>
        </div>
        <div className="kl-ws-list">
          {workspaces.length === 0 ? (
            <div className="kl-dev-empty">
              No workspaces yet. Start a session to create one.
            </div>
          ) : (
            workspaces.map((ws) => (
              <button
                key={ws.key}
                type="button"
                className={
                  "kl-ws-row" + (selected?.key === ws.key ? " active" : "")
                }
                onClick={() => {
                  setSelectedKey(ws.key);
                  setActiveFile(null);
                }}
              >
                <span className="ico">
                  <Icons.FolderOpen size={15} />
                </span>
                <span className="body">
                  <span className="name">{workspaceLabel(ws.cwd)}</span>
                  <span className="path">{ws.cwd || "No working directory"}</span>
                  <span className="meta">
                    {ws.sessions.length} session
                    {ws.sessions.length === 1 ? "" : "s"}
                  </span>
                </span>
                <span
                  className="new"
                  role="button"
                  tabIndex={-1}
                  title="New session in this workspace"
                  aria-label="New session in this workspace"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!offline && ws.cwd) onNewSession(ws.cwd);
                  }}
                >
                  <Icons.Plus size={13} />
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      {!popped.shell && <main className="kl-ws-runtime-pane">{shellPanel}</main>}

      {!popped.files && <aside className="kl-ws-runtime-pane files">{filesPanel}</aside>}
      {popped.shell && (
        <RuntimeWindow
          title={`${workspaceLabel(selected?.cwd)} - Shell`}
          onClose={() => setPopped((prev) => ({ ...prev, shell: false }))}
        >
          {shellPanel}
        </RuntimeWindow>
      )}
      {popped.files && (
        <RuntimeWindow
          title={`${workspaceLabel(selected?.cwd)} - Files`}
          onClose={() => setPopped((prev) => ({ ...prev, files: false }))}
        >
          {filesPanel}
        </RuntimeWindow>
      )}
      {popped.preview && activeFile && runtimeApi && (
        <RuntimeWindow
          title={`${activeFile.name} - Preview`}
          onClose={() => setPopped((prev) => ({ ...prev, preview: false }))}
        >
          <FilePreviewPanel
            api={runtimeApi}
            file={activeFile}
            onClose={() =>
              setPopped((prev) => ({ ...prev, preview: false }))
            }
          />
        </RuntimeWindow>
      )}
    </div>
  );
}

function buildWorkspaces(
  connectorId: string,
  sessions: SessionView[],
): WorkspaceGroup[] {
  const groups = new Map<string, { cwd: string | null; sessions: SessionView[] }>();
  for (const session of sessions) {
    if (session.connectorId !== connectorId) continue;
    const key = session.cwd || "(none)";
    const existing = groups.get(key);
    if (existing) existing.sessions.push(session);
    else groups.set(key, { cwd: session.cwd, sessions: [session] });
  }
  return Array.from(groups.entries())
    .map(([key, group]) => {
      const sorted = group.sessions
        .slice()
        .sort((a, b) => latestActivity(b).localeCompare(latestActivity(a)));
      return {
        key,
        cwd: group.cwd,
        sessions: sorted,
        latest: sorted[0]!,
      };
    })
    .sort((a, b) =>
      latestActivity(b.latest).localeCompare(latestActivity(a.latest)),
    );
}

function latestActivity(session: SessionView): string {
  return session.lastActivityAt || session.lastItemAt || session.sortAt || "";
}

function workspaceLabel(cwd: string | null | undefined): string {
  if (!cwd) return "No workspace";
  const clean = cwd.replace(/\/+$/, "");
  if (!clean || clean === "/") return "/";
  const parts = clean.split("/").filter(Boolean);
  return parts[parts.length - 1] || clean;
}

function workspaceKeyFromCwd(cwd: string | null | undefined): string | null {
  if (cwd == null) return null;
  return cwd || "(none)";
}
