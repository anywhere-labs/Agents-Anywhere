import { useCallback, useEffect, useMemo, useState } from "react";
import { Icons } from "../../../../components/Icons";
import type { FsListEntry, RuntimeApi } from "./runtimeApi";

export type PickedFile = { name: string; path: string };

type Props = {
  api: RuntimeApi;
  onClose: () => void;
  onPickFile: (file: PickedFile) => void;
  activeFile: PickedFile | null;
  showClose?: boolean;
  onPopOut?: () => void;
};

export function FilesPanel({
  api,
  onClose,
  onPickFile,
  activeFile,
  showClose = true,
  onPopOut,
}: Props) {
  const [path, setPath] = useState(".");
  const [currentPath, setCurrentPath] = useState(".");
  const [entries, setEntries] = useState<FsListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(
    async (nextPath: string) => {
      const target = nextPath.trim() || ".";
      setLoading(true);
      setError(null);
      try {
        const response = await api.fsList(target);
        setEntries(response.result.entries);
        setCurrentPath(response.result.path || target);
        setPath(response.result.path || target);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    setPath(".");
    setCurrentPath(".");
    setEntries([]);
    setError(null);
    void loadDir(".");
  }, [api.sessionId, loadDir]);

  const parentPath = useMemo(() => parentOf(currentPath || path), [currentPath, path]);
  const sortedEntries = useMemo(
    () =>
      entries.slice().sort((a, b) => {
        if (a.type === "directory" && b.type !== "directory") return -1;
        if (a.type !== "directory" && b.type === "directory") return 1;
        return a.name.localeCompare(b.name);
      }),
    [entries],
  );

  const openEntry = (entry: FsListEntry) => {
    if (entry.type === "directory") {
      void loadDir(entry.path);
      return;
    }
    if (entry.type === "file") onPickFile({ name: entry.name, path: entry.path });
  };

  return (
    <div className="kl-rt-pane">
      <div className="kl-rt-hd">
        <div className="title">
          <Icons.Files size={14} /> Files
        </div>
        <span className="sep" />
        <div className="acts">
          {onPopOut && (
            <button className="iconbtn" title="Open in window" onClick={onPopOut}>
              <Icons.External size={13} />
            </button>
          )}
          <button
            className="iconbtn"
            title="Go to parent directory"
            onClick={() => parentPath && void loadDir(parentPath)}
            disabled={loading || !parentPath}
          >
            <Icons.ChevUp size={13} />
          </button>
          <button
            className="iconbtn"
            title="Refresh"
            onClick={() => void loadDir(path)}
            disabled={loading}
          >
            {loading ? <Icons.Loader size={13} /> : <Icons.Refresh size={13} />}
          </button>
          {showClose && (
            <button className="iconbtn" title="Close" onClick={onClose}>
              <Icons.X size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="kl-fs-pathbar">
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void loadDir(path);
          }}
          aria-label="Directory path"
        />
        <button
          className="iconbtn"
          title="Open path"
          onClick={() => void loadDir(path)}
          disabled={loading || !path.trim()}
        >
          <Icons.ChevRight size={13} />
        </button>
      </div>
      <div className="kl-rt-body file-browser">
        {error && <div className="kl-fs-error">{error}</div>}
        {loading && entries.length === 0 && (
          <div className="kl-fs-empty">Loading...</div>
        )}
        {!loading && !error && entries.length === 0 && (
          <div className="kl-fs-empty">(empty)</div>
        )}
        {parentPath && (
          <button className="kl-fs-row" onClick={() => void loadDir(parentPath)}>
            <Icons.FolderOpen size={14} />
            <span>..</span>
            <em>parent</em>
          </button>
        )}
        {sortedEntries.map((entry) => (
          <button
            key={entry.path}
            className={
              "kl-fs-row" + (activeFile?.path === entry.path ? " active" : "")
            }
            onClick={() => openEntry(entry)}
            disabled={entry.type === "other"}
          >
            {entry.type === "directory" ? (
              <Icons.Folder size={14} />
            ) : (
              <Icons.File size={14} />
            )}
            <span>{entry.name}</span>
            <em>
              {entry.type === "file" && typeof entry.size === "number"
                ? formatBytes(entry.size)
                : entry.type}
            </em>
          </button>
        ))}
      </div>
    </div>
  );
}

function parentOf(rawPath: string): string {
  const clean = normalizeWindowsDrivePath(rawPath).trim().replace(/[/\\]+$/, "") || ".";
  if (clean === "." || clean === "/" || /^[A-Za-z]:[\\/]?$/.test(clean)) return "";
  const normalized = clean.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return ".";
  if (slash === 0) return "/";
  return normalized.slice(0, slash);
}

function normalizeWindowsDrivePath(path: string): string {
  return path.replace(/^\/([A-Za-z]:[\\/])/, "$1");
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
