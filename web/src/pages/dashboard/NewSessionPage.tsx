import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type HTMLAttributes,
} from "react";
import {
  ApiError,
  api,
  type ConnectorView,
  type FsEntry,
  type RuntimeConfigField,
  type RuntimeConfigSchema,
  type SessionView,
  type UploadedAttachment,
} from "../../lib/api";
import { Icons } from "../../components/Icons";
import { reportIsHealthy, runtimeLabel } from "../../lib/runtime";
import { putAttachment } from "../../lib/attachmentCache";
import { filterClaudeEffortField } from "../../lib/claudeRuntime";
import { optionLabel, runtimeConfigFields } from "./RuntimeSettingsForm";
import "./session_detail.css";

type NewSessionPageProps = {
  token: string;
  connectors: ConnectorView[];
  sessions: SessionView[];
  preferredConnectorId?: string | null;
  initialCwd?: string | null;
  onNewDevice: () => void;
  onCreated: (session: SessionView) => void;
};

const PERMISSION_MODES = [
  {
    key: "ask",
    label: "Ask approval",
    approvalPolicy: undefined,
    sandbox: undefined,
  },
  {
    key: "full",
    label: "Full access",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  },
  {
    key: "read",
    label: "Read only",
    approvalPolicy: "on-request",
    sandbox: "read-only",
  },
] as const;

type PermissionKey = (typeof PERMISSION_MODES)[number]["key"];
type HoverMenuProps = Pick<HTMLAttributes<HTMLDivElement>, "onMouseEnter" | "onMouseLeave">;

const NEW_SESSION_TITLES = [
  "What should we build next?",
  "Where should the agent start?",
  "What should we work on?",
  "Give the agent a task.",
  "Start from a workspace.",
  "What needs attention?",
  "What should happen here?",
  "Send work to the right device.",
  "Pick a workspace and begin.",
  "Describe the next change.",
  "What should be investigated?",
  "Start a focused session.",
  "What should the agent inspect?",
  "Turn an idea into a session.",
  "Choose a target and run.",
  "What are we changing today?",
] as const;

const TITLE_WRITE_MS = 58;
const TITLE_ERASE_MS = 22;
const TITLE_HOLD_MS = 15_000;
const MAX_ATTACHMENT_FILES = 5;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const COMPOSER_MENU_MARGIN = 8;
const COMPOSER_MENU_GAP = 8;
const ATTACHMENT_ONLY_PROMPT = "(No text content.)";
const LAST_SELECTION_STORAGE_KEY = "aa.newSession.lastSelection.v1";

type LastNewSessionSelection = {
  connectorId: string;
  runtime: string;
};

export function NewSessionPage({
  token,
  connectors,
  sessions,
  preferredConnectorId,
  initialCwd,
  onNewDevice,
  onCreated,
}: NewSessionPageProps) {
  const online = useMemo(
    () =>
      connectors.filter(
        (c) => c.status === "online" && attachedRuntimes(c).length > 0,
      ),
    [connectors],
  );
  const [lastSelection, setLastSelection] = useState<LastNewSessionSelection | null>(
    () => loadLastNewSessionSelection(),
  );
  const initialConnector =
    online.find((c) => c.id === preferredConnectorId) ??
    online.find((c) => c.id === lastSelection?.connectorId) ??
    online[0] ??
    null;
  const initialRuntimes = initialConnector ? attachedRuntimes(initialConnector) : [];
  const initialRuntime =
    initialRuntimes.find((item) => item.runtime === lastSelection?.runtime)?.runtime ??
    initialRuntimes[0]?.runtime ??
    "codex";
  const [connectorId, setConnectorId] = useState(initialConnector?.id ?? "");
  const connector = online.find((c) => c.id === connectorId) ?? initialConnector;
  const runtimes = useMemo(
    () => (connector ? attachedRuntimes(connector) : []),
    [connector],
  );
  const [runtime, setRuntime] = useState(initialRuntime);
  const [permissionMode, setPermissionMode] = useState<PermissionKey>("ask");
  const [prompt, setPrompt] = useState("");
  const [workspaceCwd, setWorkspaceCwd] = useState<string | null>(initialCwd || null);
  const [manualCwd, setManualCwd] = useState(initialCwd || "~");
  const [homeCwd, setHomeCwd] = useState<string | null>(null);
  const [fsEntries, setFsEntries] = useState<FsEntry[]>([]);
  const [fsLoading, setFsLoading] = useState(false);
  const [fsError, setFsError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showCreateSlowHint, setShowCreateSlowHint] = useState(false);
  const [createTick, setCreateTick] = useState(0);
  const [files, setFiles] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [filePreviewUrls, setFilePreviewUrls] = useState<Record<number, string>>({});
  const [titleIndex, setTitleIndex] = useState(0);
  const [typedTitle, setTypedTitle] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [manualWorkspace, setManualWorkspace] = useState(false);
  const [runtimeSchema, setRuntimeSchema] = useState<RuntimeConfigSchema | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<Record<string, unknown> | null>(null);
  const [permissionAnchor, setPermissionAnchor] = useState<HTMLElement | null>(null);
  const [deviceAgentAnchor, setDeviceAgentAnchor] = useState<HTMLElement | null>(null);
  const [tuningAnchor, setTuningAnchor] = useState<HTMLElement | null>(null);
  const hoverCloseRef = useRef<number | null>(null);
  const lastConnectorRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dragDepthRef = useRef(0);

  const clearHoverClose = useCallback(() => {
    if (hoverCloseRef.current === null) return;
    window.clearTimeout(hoverCloseRef.current);
    hoverCloseRef.current = null;
  }, []);

  const closeComposerMenus = useCallback(() => {
    setPermissionAnchor(null);
    setDeviceAgentAnchor(null);
    setTuningAnchor(null);
  }, []);

  const scheduleHoverClose = useCallback(() => {
    clearHoverClose();
    hoverCloseRef.current = window.setTimeout(() => {
      closeComposerMenus();
      hoverCloseRef.current = null;
    }, 160);
  }, [clearHoverClose, closeComposerMenus]);

  const hoverMenuProps = {
    onMouseEnter: clearHoverClose,
    onMouseLeave: scheduleHoverClose,
  };

  useEffect(() => clearHoverClose, [clearHoverClose]);

  useEffect(() => {
    if (creating) return;
    const title = NEW_SESSION_TITLES[titleIndex % NEW_SESSION_TITLES.length];
    let cancelled = false;
    let timeout: number | undefined;

    const schedule = (fn: () => void, delay: number) => {
      timeout = window.setTimeout(fn, delay);
    };

    const write = (count: number) => {
      if (cancelled) return;
      setTypedTitle(title.slice(0, count));
      if (count < title.length) {
        schedule(() => write(count + 1), TITLE_WRITE_MS);
        return;
      }
      schedule(() => erase(title.length), TITLE_HOLD_MS);
    };

    const erase = (count: number) => {
      if (cancelled) return;
      setTypedTitle(title.slice(0, count));
      if (count > 0) {
        schedule(() => erase(count - 1), TITLE_ERASE_MS);
        return;
      }
      setTitleIndex((idx) => (idx + 1) % NEW_SESSION_TITLES.length);
    };

    write(0);
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [creating, titleIndex]);

  useEffect(() => {
    if (!creating) {
      setShowCreateSlowHint(false);
      setCreateTick(0);
      return;
    }
    const hintTimer = window.setTimeout(() => setShowCreateSlowHint(true), 3000);
    const tickTimer = window.setInterval(() => setCreateTick((tick) => tick + 1), 450);
    return () => {
      window.clearTimeout(hintTimer);
      window.clearInterval(tickTimer);
    };
  }, [creating]);

  useEffect(() => {
    const next: Record<number, string> = {};
    files.forEach((file, idx) => {
      if (file.type.startsWith("image/")) next[idx] = URL.createObjectURL(file);
    });
    setFilePreviewUrls(next);
    return () => {
      Object.values(next).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [files]);

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
        setFsEntries(res.result.entries || []);
        setManualCwd(resolved);
      } catch (err: unknown) {
        setFsEntries([]);
        setFsError(
          err instanceof ApiError
            ? err.detail
            : err instanceof Error
              ? err.message
              : "Failed to list directory.",
        );
      } finally {
        setFsLoading(false);
      }
    },
    [connector, token],
  );

  const resolveHomeCwd = useCallback(async () => {
    if (!connector) return null;
    try {
      const res = await api.connectorFsList(token, connector.id, {
        root: "~",
        path: ".",
      });
      const resolved = res.result.path;
      return resolved && resolved !== "~" ? resolved : null;
    } catch {
      return null;
    }
  }, [connector, token]);

  useEffect(() => {
    if (!connector) return;
    const rs = attachedRuntimes(connector);
    setRuntime((prev) =>
      rs.some((r) => r.runtime === prev)
        ? prev
        : rs.find((r) => r.runtime === lastSelection?.runtime)?.runtime ||
          rs[0]?.runtime ||
          "codex",
    );
  }, [connector, lastSelection?.runtime]);

  useEffect(() => {
    if (!connector || !runtimes.some((item) => item.runtime === runtime)) return;
    const selection = { connectorId: connector.id, runtime };
    saveLastNewSessionSelection(selection);
    setLastSelection((prev) =>
      prev?.connectorId === selection.connectorId && prev.runtime === selection.runtime
        ? prev
        : selection,
    );
  }, [connector, runtime, runtimes]);

  useEffect(() => {
    if (!connector || !runtime) {
      setRuntimeSchema(null);
      setRuntimeSettings(null);
      return;
    }
    let cancelled = false;
    setRuntimeSchema(null);
    setRuntimeSettings(null);
    Promise.all([
      api.getRuntimeConfigSchema(token, runtime),
      api.getConnectorAgentSettings(token, connector.id, runtime),
    ])
      .then(([schemaResponse, settingsResponse]) => {
        if (cancelled) return;
        setRuntimeSchema(schemaResponse.schema);
        setRuntimeSettings(
          settingsResponse.runtimeSettings ?? settingsResponse.settings ?? {},
        );
      })
      .catch(() => {
        if (cancelled) return;
        setRuntimeSchema(null);
        setRuntimeSettings(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connector, runtime, token]);

  useEffect(() => {
    if (!connector) return;
    if (lastConnectorRef.current === connector.id) return;
    lastConnectorRef.current = connector.id;
    setWorkspaceCwd(initialCwd || null);
    setManualCwd(initialCwd || "~");
    setHomeCwd(null);
    setFsEntries([]);
    setFsError(null);
    setManualWorkspace(false);
    setWorkspaceOpen(false);
  }, [connector, initialCwd]);

  useEffect(() => {
    if (!connector) return;
    let cancelled = false;
    void resolveHomeCwd().then((resolved) => {
      if (!cancelled) setHomeCwd(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [connector, resolveHomeCwd]);

  useEffect(() => {
    if (!workspaceOpen) return;
    const updateMaxHeight = () => {
      const trigger = workspaceTriggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const available = Math.max(180, window.innerHeight - rect.bottom - 24);
      trigger.parentElement?.style.setProperty(
        "--kl-new-workspace-menu-max",
        `${Math.floor(available)}px`,
      );
    };
    updateMaxHeight();
    window.addEventListener("resize", updateMaxHeight);
    window.addEventListener("scroll", updateMaxHeight, true);
    return () => {
      window.removeEventListener("resize", updateMaxHeight);
      window.removeEventListener("scroll", updateMaxHeight, true);
    };
  }, [workspaceOpen]);

  const parent = useMemo(() => parentPath(manualCwd), [manualCwd]);
  const permission = PERMISSION_MODES.find((mode) => mode.key === permissionMode)!;
  const permissionLabel = permission.label;
  const workspaces = useMemo(
    () => workspaceOptions(sessions, connector?.id ?? null),
    [connector, sessions],
  );
  const selectedWorkspaceCwd = workspaceCwd?.trim() || "";
  const runtimeFields = runtimeConfigFields(runtimeSchema, runtimeSettings, "session");
  const modelField = runtimeFields.find((field) => field.key === "model");
  const effortField = filterClaudeEffortField(
    runtime,
    runtimeFields.find((field) => field.key === "effort"),
    runtimeSettings?.model,
  );
  const modelLabel = optionLabel(modelField, runtimeSettings?.model, "Model");
  const effortLabel = optionLabel(effortField, runtimeSettings?.effort, "Reasoning");
  const hasTuning = Boolean(modelField || effortField);
  const sortedFsEntries = useMemo(
    () =>
      fsEntries.slice().sort((a, b) => {
        if (a.type === "directory" && b.type !== "directory") return -1;
        if (a.type !== "directory" && b.type === "directory") return 1;
        return a.name.localeCompare(b.name);
      }),
    [fsEntries],
  );

  const autosize = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  };

  const addFiles = (picked: Iterable<File> | null) => {
    if (!picked) return;
    const incoming: File[] = [];
    let rejected = "";
    for (const file of Array.from(picked)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        rejected = `${file.name} exceeds 25 MB`;
        continue;
      }
      if (file.size === 0) {
        rejected = `${file.name} is empty`;
        continue;
      }
      incoming.push(file);
    }
    if (incoming.length === 0) {
      if (rejected) setAttachmentError(rejected);
      return;
    }
    const merged = [...files, ...incoming].slice(0, MAX_ATTACHMENT_FILES);
    if (files.length + incoming.length > MAX_ATTACHMENT_FILES) {
      rejected = `at most ${MAX_ATTACHMENT_FILES} attachments per message`;
    }
    setFiles(merged);
    setAttachmentError(rejected || null);
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
    setAttachmentError(null);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = clipboardImageFiles(event.clipboardData);
    if (images.length === 0) return;
    event.preventDefault();
    addFiles(images);
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDraggingFiles(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDraggingFiles(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDraggingFiles(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDraggingFiles(false);
    addFiles(event.dataTransfer.files);
  };

  const create = useCallback(async () => {
    if (!connector || !runtime || creating) return;
    if (!prompt.trim() && files.length === 0) return;
    setCreating(true);
    setShowCreateSlowHint(false);
    setCreateTick(0);
    setCreateError(null);
    try {
      const cwdForCreate = selectedWorkspaceCwd || homeCwd || (await resolveHomeCwd()) || "~";
      const created = await api.createSession(token, {
        connectorId: connector.id,
        runtime,
        title: prompt.trim() || undefined,
        cwd: cwdForCreate || undefined,
        approvalPolicy: permission.approvalPolicy,
        sandbox: permission.sandbox,
      });
      const takeover = await api.enableTakeover(token, created.session.id);
      const sessionId = takeover.session.id;
      if (runtimeSettings && Object.keys(runtimeSettings).length > 0) {
        await api.patchSessionRuntimeSettings(token, sessionId, runtimeSettings);
      }
      const visibleText = prompt.trim();
      const text = visibleText || (files.length > 0 ? ATTACHMENT_ONLY_PROMPT : "");
      if (text || files.length > 0) {
        let uploadedMeta: UploadedAttachment[] = [];
        let attachmentRefs: { fileId: string }[] = [];
        if (files.length > 0) {
          const upload = await api.uploadSessionAttachments(token, sessionId, files);
          uploadedMeta = upload.attachments;
          attachmentRefs = uploadedMeta.map((item) => ({ fileId: item.fileId }));
          await Promise.all(
            uploadedMeta.map((meta, idx) =>
              putAttachment({
                fileId: meta.fileId,
                sessionId,
                name: meta.name,
                mediaType: meta.mediaType,
                size: meta.size,
                blob: files[idx]!,
                createdAt: meta.createdAt,
              }),
            ),
          );
        }
        const clientMessageId = `new_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        await api.sendSessionMessage(token, sessionId, text, attachmentRefs, clientMessageId);
      }
      const selection = { connectorId: connector.id, runtime };
      saveLastNewSessionSelection(selection);
      setLastSelection((prev) =>
        prev?.connectorId === selection.connectorId && prev.runtime === selection.runtime
          ? prev
          : selection,
      );
      onCreated(takeover.session);
    } catch (err: unknown) {
      setCreateError(
        err instanceof ApiError
          ? err.detail
          : err instanceof Error
            ? err.message
            : "Failed to create session.",
      );
    } finally {
      setCreating(false);
    }
  }, [connector, creating, files, homeCwd, onCreated, permission, prompt, resolveHomeCwd, runtime, selectedWorkspaceCwd, token]);

  return (
    <div className="kl-new-page">
      <div className="kl-new-center">
        <h1 className="kl-new-title" aria-live="polite">
          <span>{creating ? `Creating session${".".repeat((createTick % 3) + 1)}` : typedTitle}</span>
          <span className="kl-new-title-cursor" aria-hidden="true" />
        </h1>
        <div
          className={`kl-comp kl-new-composer${draggingFiles ? " dragging" : ""}`}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {draggingFiles && <div className="kl-comp-drop-hint">Drop files to attach</div>}
          {files.length > 0 && (
            <div className="kl-comp-chips" role="list">
              {files.map((file, idx) => (
                <div className="kl-comp-chip" key={`${file.name}-${idx}`} role="listitem">
                  {filePreviewUrls[idx] ? (
                    <img className="kl-comp-chip-thumb" src={filePreviewUrls[idx]} alt="" />
                  ) : (
                    <span className="kl-comp-chip-icon" aria-hidden="true">
                      <Icons.Paperclip size={12} />
                    </span>
                  )}
                  <span className="kl-comp-chip-name" title={file.name}>
                    {file.name}
                  </span>
                  <button
                    type="button"
                    className="kl-comp-chip-x"
                    onClick={() => removeFile(idx)}
                    title="Remove"
                    aria-label={`Remove ${file.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {attachmentError && <div className="kl-comp-attach-error">{attachmentError}</div>}
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
              autosize(event.currentTarget);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                create();
              }
            }}
            onPaste={handlePaste}
            placeholder="Describe the task..."
            rows={1}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              addFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
            accept="image/*,application/pdf,text/*,.md,.csv,.json,.xml,.yaml,.yml,.log"
          />
          <div className="kl-comp-row">
            <button
              type="button"
              className="kl-comp-sel"
              title={
                files.length >= MAX_ATTACHMENT_FILES
                  ? `Up to ${MAX_ATTACHMENT_FILES} files`
                  : "Attach files"
              }
              disabled={files.length >= MAX_ATTACHMENT_FILES || creating}
              onClick={() => fileInputRef.current?.click()}
            >
              <Icons.Paperclip size={14} />
            </button>
            <button
              type="button"
              className="kl-comp-sel"
              title="Permission mode"
              onMouseEnter={(event) => {
                clearHoverClose();
                setDeviceAgentAnchor(null);
                setTuningAnchor(null);
                setPermissionAnchor(event.currentTarget);
              }}
              onMouseLeave={scheduleHoverClose}
              onClick={(event) => {
                event.stopPropagation();
                setDeviceAgentAnchor(null);
                setTuningAnchor(null);
                setPermissionAnchor((prev) =>
                  prev === event.currentTarget ? null : event.currentTarget,
                );
              }}
            >
              <Icons.Hand size={14} />
              {permissionLabel}
              <Icons.ChevDown size={11} />
            </button>
            <button
              type="button"
              className="kl-comp-sel"
              title="Device and agent"
              onMouseEnter={(event) => {
                clearHoverClose();
                setPermissionAnchor(null);
                setTuningAnchor(null);
                setDeviceAgentAnchor(event.currentTarget);
              }}
              onMouseLeave={scheduleHoverClose}
              onClick={(event) => {
                event.stopPropagation();
                setPermissionAnchor(null);
                setTuningAnchor(null);
                setDeviceAgentAnchor((prev) =>
                  prev === event.currentTarget ? null : event.currentTarget,
                );
              }}
            >
              <Icons.Laptop size={14} />
              {connector?.name || "Device"}
              <span className="kl-comp-sel-dotsep" />
              <span className="kl-new-agent-dot" aria-hidden="true" />
              {runtimeLabel(runtime)}
              <Icons.ChevDown size={11} />
            </button>
            {hasTuning && (
              <button
                type="button"
                className="kl-comp-sel kl-comp-tuning-sel"
                title="Model and reasoning effort"
                onMouseEnter={(event) => {
                  clearHoverClose();
                  setPermissionAnchor(null);
                  setDeviceAgentAnchor(null);
                  setTuningAnchor(event.currentTarget);
                }}
                onMouseLeave={scheduleHoverClose}
                onClick={(event) => {
                  event.stopPropagation();
                  setPermissionAnchor(null);
                  setDeviceAgentAnchor(null);
                  setTuningAnchor((prev) =>
                    prev === event.currentTarget ? null : event.currentTarget,
                  );
                }}
              >
                {effortField && <span className="tier">{effortLabel}</span>}
                {effortField && modelField && <span className="kl-comp-sel-dotsep" />}
                {modelField && <span>{modelLabel}</span>}
                <Icons.ChevDown size={11} />
              </button>
            )}
            <span className="sep" />
            <button
              type="button"
              className="kl-send"
              onClick={create}
              disabled={!connector || !runtime || creating || (!prompt.trim() && files.length === 0)}
              title="Create session"
            >
              {creating ? <Icons.Loader size={16} /> : <Icons.ArrowUp size={16} />}
            </button>
          </div>
        </div>
        {permissionAnchor && (
          <NewPermissionMenu
            anchor={permissionAnchor}
            value={permissionMode}
            onChange={setPermissionMode}
            onClose={() => setPermissionAnchor(null)}
            hoverProps={hoverMenuProps}
          />
        )}
        {deviceAgentAnchor && (
          <DeviceAgentMenu
            anchor={deviceAgentAnchor}
            devices={online}
            selectedDeviceId={connector?.id ?? ""}
            selectedRuntime={runtime}
            onChange={(nextConnectorId, nextRuntime) => {
              if (nextConnectorId !== connector?.id) {
                setConnectorId(nextConnectorId);
                setWorkspaceCwd(null);
                setManualCwd("~");
                setWorkspaceOpen(false);
                setManualWorkspace(false);
              }
              setRuntime(nextRuntime);
            }}
            onClose={() => setDeviceAgentAnchor(null)}
            hoverProps={hoverMenuProps}
          />
        )}
        {tuningAnchor && (
          <NewModelEffortMenu
            anchor={tuningAnchor}
            effortField={effortField}
            modelField={modelField}
            settings={runtimeSettings ?? {}}
            onPatch={(patch) =>
              setRuntimeSettings((prev) => ({ ...(prev ?? {}), ...patch }))
            }
            onClose={() => setTuningAnchor(null)}
            hoverProps={hoverMenuProps}
          />
        )}
        <div className="kl-new-workspace">
          <button
            ref={workspaceTriggerRef}
            type="button"
            className={`kl-new-workspace-trigger${workspaceOpen ? " on" : ""}`}
            onClick={() => setWorkspaceOpen((open) => !open)}
            disabled={!connector}
            title={selectedWorkspaceCwd || homeCwd || "Home directory"}
          >
            <Icons.Folder size={14} />
            <span>{selectedWorkspaceCwd ? workspaceLabel(selectedWorkspaceCwd) : "Home directory"}</span>
            <em>{selectedWorkspaceCwd || homeCwd || "Default workspace"}</em>
            <Icons.ChevDown size={13} />
          </button>
          {workspaceOpen && (
            <div className={`kl-new-workspace-menu${manualWorkspace ? " manual" : ""}`}>
              <div className="kl-new-workspace-list">
                <button
                  type="button"
                  className={`kl-new-workspace-row${!selectedWorkspaceCwd ? " active" : ""}`}
                  onClick={() => {
                    setWorkspaceCwd(null);
                    setManualCwd("~");
                    setFsError(null);
                    setManualWorkspace(false);
                    setWorkspaceOpen(false);
                  }}
                  title="Home directory"
                >
                  <Icons.Folder size={14} />
                  <span>Home directory</span>
                  <em>Default workspace</em>
                </button>
                <button
                  type="button"
                  className={`kl-new-workspace-row${manualWorkspace ? " active" : ""}`}
                  onClick={() => {
                    setManualWorkspace(true);
                    void loadDir(manualCwd);
                  }}
                >
                  <Icons.Search size={14} />
                  <span>Choose path</span>
                  <em>Enter a directory manually</em>
                </button>
                {workspaces.map((item) => (
                  <button
                    type="button"
                    key={`${item.connectorId}:${item.cwd}`}
                    className={`kl-new-workspace-row${item.cwd === selectedWorkspaceCwd ? " active" : ""}`}
                    onClick={() => {
                      setWorkspaceCwd(item.cwd);
                      setManualCwd(item.cwd);
                      setFsError(null);
                      setManualWorkspace(false);
                      setWorkspaceOpen(false);
                    }}
                    title={item.cwd}
                  >
                    <Icons.Folder size={14} />
                    <span>{workspaceLabel(item.cwd)}</span>
                    <em>{item.cwd}</em>
                  </button>
                ))}
              </div>
              {manualWorkspace && (
                <div className="kl-new-workspace-picker">
                  <div className="kl-new-workspace-manual">
                    <input
                      value={manualCwd}
                      onChange={(event) => setManualCwd(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void loadDir(manualCwd);
                      }}
                      placeholder="~/code/project"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => parent && void loadDir(parent)}
                      disabled={!parent || fsLoading}
                      title="Parent directory"
                    >
                      <Icons.ChevUp size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setWorkspaceCwd(manualCwd.trim() || "~");
                        setManualCwd(manualCwd.trim() || "~");
                        setWorkspaceOpen(false);
                        setManualWorkspace(false);
                        setFsError(null);
                      }}
                      disabled={!manualCwd.trim() || fsLoading}
                      title="Use this path"
                    >
                      {fsLoading ? <Icons.Loader size={13} /> : <Icons.Check size={13} />}
                    </button>
                  </div>
                  <div className="kl-new-fs-list">
                    {fsError && <div className="kl-fs-error">{fsError}</div>}
                    {fsLoading && sortedFsEntries.length === 0 && (
                      <div className="kl-fs-empty">Loading...</div>
                    )}
                    {!fsLoading && !fsError && sortedFsEntries.length === 0 && (
                      <div className="kl-fs-empty">(empty)</div>
                    )}
                    {parent && (
                      <button className="kl-fs-row" onClick={() => void loadDir(parent)}>
                        <Icons.FolderOpen size={14} />
                        <span>..</span>
                        <em>parent</em>
                      </button>
                    )}
                    {sortedFsEntries.map((entry) => (
                      <button
                        key={entry.path}
                        className="kl-fs-row"
                        onClick={() => {
                          if (entry.type === "directory") void loadDir(entry.path);
                        }}
                        disabled={entry.type !== "directory"}
                      >
                        {entry.type === "directory" ? (
                          <Icons.Folder size={14} />
                        ) : (
                          <Icons.File size={14} />
                        )}
                        <span>{entry.name}</span>
                        <em>{entry.type}</em>
                      </button>
                    ))}
                  </div>
                  <div className="kl-new-workspace-picker-actions">
                    <button
                      type="button"
                      className="kl-btn ghost"
                      onClick={() => {
                        setWorkspaceCwd(null);
                        setWorkspaceOpen(false);
                        setManualWorkspace(false);
                      }}
                    >
                      Use home
                    </button>
                    <button
                      type="button"
                      className="kl-btn"
                      onClick={() => {
                        setWorkspaceCwd(manualCwd);
                        setWorkspaceOpen(false);
                        setManualWorkspace(false);
                        setFsError(null);
                      }}
                      disabled={!manualCwd.trim()}
                    >
                      Use this folder
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        {createError && <div className="kl-new-error">{createError}</div>}
        {showCreateSlowHint && (
          <div className="kl-new-hint">
            Creating this session can take a little while. You can leave this open.
          </div>
        )}
        {fsError && <div className="kl-new-error">{fsError}</div>}
        {!connector && (
          <div className="kl-new-empty">
            <span>No online device with an agent is available.</span>
            <button type="button" className="kl-btn ghost" onClick={onNewDevice}>
              <Icons.Plus size={14} />
              Add new device
            </button>
          </div>
        )}
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

function loadLastNewSessionSelection(): LastNewSessionSelection | null {
  try {
    const raw = localStorage.getItem(LAST_SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastNewSessionSelection>;
    if (typeof parsed.connectorId !== "string" || typeof parsed.runtime !== "string") {
      return null;
    }
    if (!parsed.connectorId || !parsed.runtime) return null;
    return { connectorId: parsed.connectorId, runtime: parsed.runtime };
  } catch {
    return null;
  }
}

function saveLastNewSessionSelection(selection: LastNewSessionSelection) {
  try {
    localStorage.setItem(LAST_SELECTION_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Browser storage can be unavailable or full; selection persistence is optional.
  }
}

function NewPermissionMenu({
  anchor,
  value,
  onChange,
  onClose,
  hoverProps,
}: {
  anchor: HTMLElement;
  value: PermissionKey;
  onChange: (value: PermissionKey) => void;
  onClose: () => void;
  hoverProps: HoverMenuProps;
}) {
  const ref = useDismissableMenu(anchor, onClose);
  const style = composerMenuStyle(anchor, 220, 44 + PERMISSION_MODES.length * 36);
  return (
    <div ref={ref} className="kl-comp-menu kl-new-popover" style={style} {...hoverProps}>
      <div className="kl-comp-menu-hd">
        <span>Permission mode</span>
      </div>
      {PERMISSION_MODES.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`kl-comp-menu-row${value === item.key ? " on" : ""}`}
          onClick={() => {
            onChange(item.key);
            onClose();
          }}
        >
          <span>{item.label}</span>
          <Icons.Check size={13} />
        </button>
      ))}
    </div>
  );
}

function DeviceAgentMenu({
  anchor,
  devices,
  selectedDeviceId,
  selectedRuntime,
  onChange,
  onClose,
  hoverProps,
}: {
  anchor: HTMLElement;
  devices: ConnectorView[];
  selectedDeviceId: string;
  selectedRuntime: string;
  onChange: (connectorId: string, runtime: string) => void;
  onClose: () => void;
  hoverProps: HoverMenuProps;
}) {
  const ref = useDismissableMenu(anchor, onClose);
  const [activeDeviceId, setActiveDeviceId] = useState(selectedDeviceId);
  const activeDevice =
    devices.find((device) => device.id === activeDeviceId) ?? devices[0] ?? null;
  const activeRuntimes = activeDevice ? attachedRuntimes(activeDevice) : [];
  const rows = Math.max(devices.length, activeRuntimes.length, 1);
  const style = composerMenuStyle(anchor, 380, 44 + rows * 38);
  return (
    <div ref={ref} className="kl-comp-menu kl-new-device-agent-menu" style={style} {...hoverProps}>
      <div className="kl-new-device-agent-cols">
        <div>
          <div className="kl-comp-menu-hd">
            <span>Device</span>
          </div>
          {devices.map((device) => (
            <button
              key={device.id}
              type="button"
              className={`kl-comp-menu-row${activeDevice?.id === device.id ? " active" : ""}`}
              onClick={() => setActiveDeviceId(device.id)}
            >
              <span>{device.name}</span>
              {activeDevice?.id === device.id && <Icons.Check size={13} />}
            </button>
          ))}
        </div>
        <div>
          <div className="kl-comp-menu-hd">
            <span>Agent</span>
          </div>
          {activeRuntimes.map((item) => (
            <button
              key={item.runtime}
              type="button"
              className={`kl-comp-menu-row${
                activeDevice?.id === selectedDeviceId && selectedRuntime === item.runtime
                  ? " on"
                  : ""
              }`}
              onClick={() => {
                if (!activeDevice) return;
                onChange(activeDevice.id, item.runtime);
                onClose();
              }}
            >
              <span>{runtimeLabel(item.runtime)}</span>
              <Icons.Check size={13} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function NewModelEffortMenu({
  anchor,
  effortField,
  modelField,
  settings,
  onPatch,
  onClose,
  hoverProps,
}: {
  anchor: HTMLElement;
  effortField: RuntimeConfigField | null | undefined;
  modelField: RuntimeConfigField | null | undefined;
  settings: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
  onClose: () => void;
  hoverProps: HoverMenuProps;
}) {
  const ref = useDismissableMenu(anchor, onClose);
  const effortItems = toComposerMenuItems(effortField);
  const modelItems = toComposerMenuItems(modelField);
  const rows = effortItems.length + modelItems.length + (effortItems.length && modelItems.length ? 1 : 0);
  const style = composerMenuStyle(anchor, 260, 56 + rows * 36);
  const effortValue = effectiveFieldValue(effortField, settings.effort);
  const modelValue = effectiveFieldValue(modelField, settings.model);
  return (
    <div ref={ref} className="kl-comp-menu kl-new-popover" style={style} {...hoverProps}>
      {effortItems.length > 0 && (
        <>
          <div className="kl-comp-menu-hd">
            <span>Reasoning</span>
          </div>
          {effortItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`kl-comp-menu-row${effortValue === item.id ? " on" : ""}`}
              onClick={() => {
                onPatch({ effort: item.id });
                onClose();
              }}
            >
              <span>{item.label}</span>
              <Icons.Check size={13} />
            </button>
          ))}
        </>
      )}
      {effortItems.length > 0 && modelItems.length > 0 && (
        <div className="kl-comp-menu-sep" />
      )}
      {modelItems.length > 0 && (
        <>
          <div className="kl-comp-menu-hd">
            <span>Model</span>
          </div>
          {modelItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`kl-comp-menu-row${modelValue === item.id ? " on" : ""}`}
              onClick={() => {
                onPatch({ model: item.id });
                onClose();
              }}
            >
              <span>{item.label}</span>
              <Icons.Check size={13} />
            </button>
          ))}
        </>
      )}
    </div>
  );
}

function useDismissableMenu(anchor: HTMLElement, onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);
  return ref;
}

type ComposerMenuItem = {
  id: string;
  label: string;
  description?: string | null;
};

function toComposerMenuItems(
  field: RuntimeConfigField | null | undefined,
): ComposerMenuItem[] {
  return (
    field?.options?.map((option) => ({
      id: String(option.value),
      label: option.label,
      description: option.description,
    })) ?? []
  );
}

function effectiveFieldValue(
  field: RuntimeConfigField | null | undefined,
  value: unknown,
): string {
  if (typeof value === "string") return value;
  return field?.options?.[0] ? String(field.options[0].value) : "";
}

function composerMenuStyle(
  anchor: HTMLElement,
  requestedWidth: number,
  estimatedHeight: number,
): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(
    requestedWidth,
    Math.max(160, viewportWidth - COMPOSER_MENU_MARGIN * 2),
  );
  const left = Math.min(
    Math.max(COMPOSER_MENU_MARGIN, rect.left),
    Math.max(COMPOSER_MENU_MARGIN, viewportWidth - width - COMPOSER_MENU_MARGIN),
  );
  const spaceAbove = Math.max(0, rect.top - COMPOSER_MENU_MARGIN - COMPOSER_MENU_GAP);
  const spaceBelow = Math.max(
    0,
    viewportHeight - rect.bottom - COMPOSER_MENU_MARGIN - COMPOSER_MENU_GAP,
  );
  const placeAbove = spaceAbove >= estimatedHeight || spaceAbove > spaceBelow;
  if (placeAbove) {
    return {
      bottom: viewportHeight - rect.top + COMPOSER_MENU_GAP,
      left,
      width,
      maxHeight: Math.max(120, spaceAbove),
    };
  }
  return {
    top: rect.bottom + COMPOSER_MENU_GAP,
    left,
    width,
    maxHeight: Math.max(120, spaceBelow),
  };
}

function workspaceOptions(sessions: SessionView[], connectorId: string | null) {
  const seen = new Set<string>();
  return sessions
    .filter((session) => session.cwd && session.connectorId === connectorId)
    .map((session) => ({
      cwd: session.cwd!,
      connectorId: session.connectorId,
      updatedAt:
        Date.parse(
          session.lastActivityAt ||
            session.lastItemAt ||
            session.lastSyncedAt ||
            "",
        ) || 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((item) => {
      const key = `${item.connectorId}:${item.cwd}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 18);
}

function workspaceLabel(cwd: string | null | undefined): string {
  if (!cwd) return "Choose workspace";
  const trimmed = cwd.replace(/[/\\]+$/, "");
  if (!trimmed || trimmed === "~" || trimmed === "/") return trimmed || cwd;
  const parts = trimmed.split(/[/\\]+/);
  return parts.at(-1) || cwd;
}

function attachmentImageExtension(type: string): string {
  switch (type) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/png":
    default:
      return "png";
  }
}

function normalizePastedImage(file: File, index: number): File {
  if (file.name) return file;
  const ext = attachmentImageExtension(file.type);
  return new File([file], `pasted-image-${Date.now()}-${index + 1}.${ext}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

function dataTransferHasFiles(dataTransfer: DataTransfer): boolean {
  return (
    Array.from(dataTransfer.types).includes("Files") ||
    dataTransfer.files.length > 0
  );
}

function clipboardImageFiles(data: DataTransfer): File[] {
  const byFileList = Array.from(data.files).filter((file) =>
    file.type.startsWith("image/"),
  );
  if (byFileList.length > 0) {
    return byFileList.map((file, index) => normalizePastedImage(file, index));
  }
  return Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))
    .map((file, index) => normalizePastedImage(file, index));
}

function parentPath(path: string): string {
  const clean = normalizeWindowsDrivePath(path).trim().replace(/[/\\]+$/, "") || ".";
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
