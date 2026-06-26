import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type WheelEvent,
} from "react";
import {
  ApiError,
  api,
  type Approval,
  type ApprovalResolveStatus,
  type ConnectorView,
  type RuntimeConfigField,
  type RuntimeConfigSchema,
  type SessionView,
  type TimelineItem,
  type UploadedAttachment,
} from "../../lib/api";
import { Icons } from "../../components/Icons";
import { runtimeAccent, runtimeLabel } from "../../lib/runtime";
import { CopyButton, SessionMessageMarkdown } from "./SessionMessageMarkdown";
import { AnsiText } from "./AnsiText";
import { MessageAttachments } from "./MessageAttachments";
import { putAttachment } from "../../lib/attachmentCache";
import {
  extractAttachments,
  mergeOptimisticTimelineItems,
  stripInjectedAttachmentMentions,
  userMessageMatches,
} from "../../lib/attachmentReconcile";
import { workspaceKey } from "./Sidebar";
import { FilesPanel, type PickedFile } from "./session-detail/runtime/FilesPanel";
import { FilePreviewPanel } from "./session-detail/runtime/FilePreviewPanel";
import { RuntimeWindow } from "./session-detail/runtime/RuntimeWindow";
import { TerminalPanel } from "./session-detail/runtime/TerminalPanel";
import { RuntimePanel } from "./session-detail/runtime/RuntimePanel";
import { useRuntimeLayout } from "./session-detail/runtime/useRuntimeLayout";
import { makeRuntimeApi } from "./session-detail/runtime/runtimeApi";
import { optionLabel, runtimeConfigFields } from "./RuntimeSettingsForm";
import { RunModeGuide } from "./RunModeGuide";
import { filterClaudeEffortField } from "../../lib/claudeRuntime";
import { ConfirmModal } from "./ConfirmModal";
import "./session-detail/runtime/runtime.css";
import "./session_detail.css";

type SessionDetailViewProps = {
  token: string;
  session: SessionView;
  connector: ConnectorView | null;
  onSessionRefreshed: (next: SessionView) => void;
  onUnauthorized: () => void;
  /** True when the parent dashboard's sidebar is collapsed — used to add
   * left padding to the header so the title doesn't overlap the absolute-
   * positioned expand button, and to widen the runtime panel a bit. */
  sidebarCollapsed?: boolean;
};

type TimelineState = {
  itemsById: Record<string, TimelineItem>;
  approvals: Approval[];
  nextSeq: number;
};

type PendingSend = {
  content: string;
  files: File[];
};

// SSE (see effect below) is the primary update path and CARRIES the item
// payloads — the frontend applies them directly and does NOT hit GET /state
// per event. GET /state is reserved for: initial load, SSE-reconnect
// catch-up, and this dead-SSE fallback poll. The fallback only fires while
// the EventSource is not OPEN, so a healthy SSE means zero background polls
// (this is what was hammering the backend before — every SSE event used to
// trigger a full /state refetch).
const SSE_FALLBACK_POLL_MS = 3000;
const STATE_PAGE_LIMIT = 500;
const STREAM_REVEAL_MIN_CHARS_PER_SECOND = 260;
const STREAM_REVEAL_FAST_CHARS_PER_SECOND = 1600;
const STREAM_MARKDOWN_MIN_INTERVAL_MS = 34;

type PendingTimelineDelta = {
  itemsById: Record<string, TimelineItem>;
  approvals?: Approval[];
  session?: SessionView;
  nextSeq?: number;
  replaceItems?: boolean;
};

export function SessionDetailView({
  token,
  session,
  connector,
  onSessionRefreshed,
  onUnauthorized,
  sidebarCollapsed = false,
}: SessionDetailViewProps) {
  const sessionId = session.id;

  // ─── Files / Terminal runtime panel (right side) ──────────────────────
  const [previewFile, setPreviewFile] = useState<PickedFile | null>(null);
  const [poppedRuntime, setPoppedRuntime] = useState({
    files: false,
    term: false,
    preview: false,
  });
  const runtimeLayout = useRuntimeLayout(sidebarCollapsed);
  const runtimeApi = useMemo(
    () =>
      makeRuntimeApi({
        sessionId,
        connectorId: session.connectorId,
        root: session.cwd,
        token,
      }),
    [session.connectorId, session.cwd, sessionId, token],
  );
  // When the session changes, drop the open preview (it pointed at the old workspace).
  useEffect(() => {
    setPreviewFile(null);
    setPoppedRuntime({ files: false, term: false, preview: false });
  }, [sessionId, session.runtime]);

  const [state, setState] = useState<TimelineState>({
    itemsById: {},
    approvals: [],
    nextSeq: 0,
  });
  const [loadingFirstBatch, setLoadingFirstBatch] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [runtimeSettingsSchema, setRuntimeSettingsSchema] =
    useState<RuntimeConfigSchema | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<Record<string, unknown> | null>(
    session.runtimeSettings ?? null,
  );
  const [runtimeSettingsError, setRuntimeSettingsError] = useState<string | null>(null);

  // Optimistic UI: messages render immediately and the Interrupt button flips
  // immediately, both ahead of the backend round-trip. Real items arriving via
  // polling dedupe the optimistic ones; an API error rolls each back.
  const [optimisticItems, setOptimisticItems] = useState<TimelineItem[]>([]);
  const [interrupting, setInterrupting] = useState(false);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const [resolvingApprovalStatus, setResolvingApprovalStatus] =
    useState<ApprovalResolveStatus | null>(null);
  const [exitingApprovalId, setExitingApprovalId] = useState<string | null>(null);
  const [locallyResolvedApprovalIds, setLocallyResolvedApprovalIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [takeoverConfirm, setTakeoverConfirm] = useState<"enable" | "disable" | null>(
    null,
  );
  const [runModePromptOpen, setRunModePromptOpen] = useState(false);
  const [defaultRunModeConfigured, setDefaultRunModeConfigured] = useState(
    session.runtime !== "claude",
  );
  const [pendingRunModeSend, setPendingRunModeSend] = useState<PendingSend | null>(
    null,
  );
  const [pendingErrorSend, setPendingErrorSend] = useState<PendingSend | null>(
    null,
  );

  // Reset timeline whenever the active session changes.
  useEffect(() => {
    setState({ itemsById: {}, approvals: [], nextSeq: 0 });
    setLoadingFirstBatch(true);
    setActionError(null);
    setRuntimeSettingsSchema(null);
    setRuntimeSettings(session.runtimeSettings ?? null);
    setRuntimeSettingsError(null);
    setOptimisticItems([]);
    setInterrupting(false);
    setResolvingApprovalId(null);
    setResolvingApprovalStatus(null);
    setExitingApprovalId(null);
    setLocallyResolvedApprovalIds(new Set());
    setRunModePromptOpen(false);
    setDefaultRunModeConfigured(session.runtime !== "claude");
    setPendingRunModeSend(null);
    setPendingErrorSend(null);
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    setRuntimeSettingsError(null);
    Promise.all([
      api.getRuntimeConfigSchema(token, session.runtime),
      api.getSessionRuntimeSettings(token, sessionId),
    ])
      .then(([schemaRes, settingsRes]) => {
        if (cancelled) return;
        setRuntimeSettingsSchema(schemaRes.schema);
        setRuntimeSettings(settingsRes.runtimeSettings ?? settingsRes.settings);
        setDefaultRunModeConfigured(
          session.runtime !== "claude" || settingsRes.defaultRunModeConfigured,
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof ApiError
            ? err.detail
            : err instanceof Error
              ? err.message
              : "Failed to load runtime settings.";
        setRuntimeSettingsError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [session.runtime, sessionId, token]);

  // Hold the latest callbacks in refs so the polling effect doesn't restart
  // when parents pass inline arrow functions.
  const onSessionRefreshedRef = useRef(onSessionRefreshed);
  const onUnauthorizedRef = useRef(onUnauthorized);
  useEffect(() => {
    onSessionRefreshedRef.current = onSessionRefreshed;
    onUnauthorizedRef.current = onUnauthorized;
  });

  // Authoritative read cursor. Updated synchronously (not via a state-derived
  // effect) so it never lags behind a deferred React commit — a stale cursor
  // previously made every fetch return the full 200-item window.
  const nextSeqRef = useRef(0);
  const pendingDeltaRef = useRef<PendingTimelineDelta | null>(null);
  const pendingFrameRef = useRef(0);

  useEffect(() => {
    nextSeqRef.current = 0;
    pendingDeltaRef.current = null;
    pendingFrameRef.current = 0;
    let cancelled = false;
    let inFlight = false;

    type Delta = {
      items?: TimelineItem[];
      approvals?: Approval[];
      session?: SessionView;
      nextSeq?: number;
      replaceItems?: boolean;
    };

    function commitDelta(delta: PendingTimelineDelta) {
      if (typeof delta.nextSeq === "number") {
        nextSeqRef.current = Math.max(nextSeqRef.current, delta.nextSeq);
      }
      if (delta.session) onSessionRefreshedRef.current(delta.session);
      setState((prev) => {
        let itemsById = delta.replaceItems ? {} : prev.itemsById;
        const items = Object.values(delta.itemsById);
        if (items.length) {
          itemsById = { ...itemsById };
          for (const item of items) {
            const existing = itemsById[item.id];
            if (!existing || existing.updatedSeq <= item.updatedSeq) {
              itemsById[item.id] = item;
            }
          }
        }
        return {
          itemsById,
          approvals: delta.approvals ?? prev.approvals,
          nextSeq: Math.max(prev.nextSeq, delta.nextSeq ?? prev.nextSeq),
        };
      });
      setLoadingFirstBatch(false);
    }

    function flushPendingDelta() {
      pendingFrameRef.current = 0;
      const pending = pendingDeltaRef.current;
      pendingDeltaRef.current = null;
      if (!pending || cancelled) return;
      commitDelta(pending);
    }

    // Merge a delta (from SSE payload OR a GET /state response) into state.
    // The cursor advances synchronously, while React commits are frame-batched.
    function applyDelta(delta: Delta, options: { immediate?: boolean } = {}) {
      if (typeof delta.nextSeq === "number") {
        nextSeqRef.current = Math.max(nextSeqRef.current, delta.nextSeq);
      }
      const pending =
        pendingDeltaRef.current ??
        (pendingDeltaRef.current = { itemsById: {} });
      if (delta.replaceItems) {
        pending.itemsById = {};
        pending.replaceItems = true;
      }
      if (delta.items && delta.items.length) {
        for (const item of delta.items) {
          const existing = pending.itemsById[item.id];
          if (!existing || existing.updatedSeq <= item.updatedSeq) {
            pending.itemsById[item.id] = item;
          }
        }
      }
      if (delta.approvals) pending.approvals = delta.approvals;
      if (delta.session) pending.session = delta.session;
      if (typeof delta.nextSeq === "number") {
        pending.nextSeq = Math.max(pending.nextSeq ?? 0, delta.nextSeq);
      }
      if (
        options.immediate ||
        typeof requestAnimationFrame === "undefined"
      ) {
        if (pendingFrameRef.current) {
          if (typeof cancelAnimationFrame !== "undefined") {
            cancelAnimationFrame(pendingFrameRef.current);
          }
          pendingFrameRef.current = 0;
        }
        flushPendingDelta();
        return;
      }
      if (!pendingFrameRef.current) {
        pendingFrameRef.current = requestAnimationFrame(flushPendingDelta);
      }
    }

    // Full GET /state reconcile. Used ONLY for: initial load, SSE-reconnect
    // catch-up (refetch envelopes), bulk syncs, and the dead-SSE fallback poll.
    // Never per streaming event.
    async function refetch() {
      if (cancelled || inFlight) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      inFlight = true;
      try {
        let afterSeq = 0;
        let hasMore = true;
        let collectedItems: TimelineItem[] = [];
        let latestApprovals: Approval[] | undefined;
        let latestSession: SessionView | undefined;
        let latestNextSeq = nextSeqRef.current;
        while (!cancelled && hasMore) {
          const response = await api.getSessionState(
            token,
            sessionId,
            afterSeq,
            STATE_PAGE_LIMIT,
          );
          if (cancelled) return;
          collectedItems = [...collectedItems, ...response.items];
          latestApprovals = response.approvals;
          latestSession = response.session;
          latestNextSeq = Math.max(latestNextSeq, response.nextSeq);
          hasMore = response.hasMore;
          const lastItem = response.items.at(-1);
          if (!lastItem || lastItem.updatedSeq <= afterSeq) {
            break;
          }
          afterSeq = lastItem.updatedSeq;
          nextSeqRef.current = Math.max(nextSeqRef.current, afterSeq);
        }
        applyDelta(
          {
            items: collectedItems,
            approvals: latestApprovals,
            session: latestSession,
            nextSeq: latestNextSeq,
            replaceItems: true,
          },
          { immediate: true },
        );
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorizedRef.current();
        }
      } finally {
        inFlight = false;
      }
    }

    // Initial load.
    refetch();

    // SSE: steady-state events carry item payloads — apply directly, no
    // /state call. A `refetch` envelope (initial frame + bulk sync) triggers
    // exactly one full GET /state reconcile.
    let eventSource: EventSource | null = null;
    try {
      eventSource = new EventSource(api.sessionEventsUrl(token, sessionId));
      eventSource.onmessage = (event: MessageEvent) => {
        if (cancelled || !event.data) return;
        let envelope: (Delta & { refetch?: boolean }) | null = null;
        try {
          envelope = JSON.parse(event.data as string);
        } catch {
          return;
        }
        if (!envelope) return;
        if (envelope.refetch) {
          refetch();
          return;
        }
        applyDelta(envelope);
      };
      // No onerror: EventSource auto-reconnects, and the server replays a
      // `refetch` initial frame on reconnect to catch up missed items.
    } catch {
      eventSource = null;
    }

    // Fallback poll — fires only while the SSE is NOT open (connecting / dead,
    // e.g. a proxy that buffers event-streams). Healthy SSE = zero polls.
    const intervalId = setInterval(() => {
      if (eventSource && eventSource.readyState === EventSource.OPEN) return;
      refetch();
    }, SSE_FALLBACK_POLL_MS);

    function onVisibility() {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "visible"
      ) {
        refetch();
      }
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      if (eventSource) eventSource.close();
      if (
        pendingFrameRef.current &&
        typeof cancelAnimationFrame !== "undefined"
      ) {
        cancelAnimationFrame(pendingFrameRef.current);
      }
      pendingFrameRef.current = 0;
      pendingDeltaRef.current = null;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [token, sessionId]);

  const items = useMemo(() => {
    const real = Object.values(state.itemsById).sort(
      (a, b) => a.orderSeq - b.orderSeq || a.updatedSeq - b.updatedSeq,
    );

    return mergeOptimisticTimelineItems(real, optimisticItems);
  }, [state.itemsById, optimisticItems]);

  // GC optimistic items from state once their real counterpart lands (keeps
  // memory + the "Sending…" status honest). Failed ones stay until the user
  // leaves the session so they can see the send didn't go through.
  useEffect(() => {
    if (optimisticItems.length === 0) return;
    setOptimisticItems((prev) => {
      const next = prev.filter((opt) => {
        if (opt.status === "failed") return true;
        const matched = Object.values(state.itemsById).some((real) =>
          userMessageMatches(real, opt.id),
        );
        return !matched;
      });
      return next.length === prev.length ? prev : next;
    });
  }, [state.itemsById, optimisticItems]);

  const approvalByTarget = useMemo(() => {
    const map: Record<string, Approval> = {};
    for (const approval of state.approvals) {
      if (approval.targetItemId) map[approval.targetItemId] = approval;
    }
    return map;
  }, [state.approvals]);

  const detachedApprovals = useMemo(
    () => state.approvals.filter((a) => !a.targetItemId),
    [state.approvals],
  );

  const pendingApprovals = useMemo(
    () =>
      state.approvals
        .filter((approval) => approval.status === "pending")
        .filter((approval) => !locallyResolvedApprovalIds.has(approval.id))
        .sort((a, b) => {
          if (a.updatedSeq !== b.updatedSeq) return a.updatedSeq - b.updatedSeq;
          return a.createdAt.localeCompare(b.createdAt);
        }),
    [locallyResolvedApprovalIds, state.approvals],
  );
  const pendingApproval = pendingApprovals[0] ?? null;

  useEffect(() => {
    if (locallyResolvedApprovalIds.size === 0) return;
    const stillPending = new Set(
      state.approvals
        .filter((approval) => approval.status === "pending")
        .map((approval) => approval.id),
    );
    setLocallyResolvedApprovalIds((prev) => {
      const next = new Set([...prev].filter((id) => stillPending.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [locallyResolvedApprovalIds.size, state.approvals]);

  // ─── Takeover toggle ──────────────────────────────────────────────────
  const [takeoverInFlight, setTakeoverInFlight] = useState(false);
  const applyTakeover = useCallback(async () => {
    if (takeoverInFlight) return;
    setTakeoverInFlight(true);
    try {
      const response = session.takeover
        ? await api.disableTakeover(token, sessionId)
        : await api.enableTakeover(token, sessionId);
      onSessionRefreshed(response.session);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) onUnauthorized();
        else setActionError(err.detail);
      }
    } finally {
      setTakeoverInFlight(false);
      setTakeoverConfirm(null);
    }
  }, [
    session.takeover,
    sessionId,
    token,
    takeoverInFlight,
    onSessionRefreshed,
    onUnauthorized,
  ]);

  const handleToggleTakeover = useCallback(() => {
    setTakeoverConfirm(session.takeover ? "disable" : "enable");
  }, [session.takeover]);

  // ─── Send / interrupt / resolve approval ──────────────────────────────
  // While the interrupt request is in flight (or until the next poll confirms
  // the turn ended), pretend the session isn't busy — the Composer flips back
  // to the send button instantly. The auto-clear effect below releases the
  // override once `session.status` actually leaves running/waiting_approval.
  const serverBusy =
    session.status === "running" || session.status === "waiting_approval";
  const isBusy = serverBusy && !interrupting;

  useEffect(() => {
    if (interrupting && !serverBusy) setInterrupting(false);
  }, [interrupting, serverBusy]);

  const sendNow = useCallback(
    async (content: string, files: File[] = []) => {
      // 1) Upload first so the optimistic message can show real thumbnails.
      //    On failure we surface the error and skip the optimistic message —
      //    the textarea retains the text so the user can retry.
      let attachmentRefs: { fileId: string }[] = [];
      let uploadedMeta: UploadedAttachment[] = [];
      if (files.length > 0) {
        try {
          const result = await api.uploadSessionAttachments(token, sessionId, files);
          uploadedMeta = result.attachments;
          attachmentRefs = result.attachments.map((a) => ({ fileId: a.fileId }));
          // Keep a local preview cache so recent image chips render instantly;
          // the platform file remains durable on the backend.
          await Promise.all(
            uploadedMeta.map((meta, i) =>
              putAttachment({
                fileId: meta.fileId,
                sessionId,
                name: meta.name,
                mediaType: meta.mediaType,
                size: meta.size,
                blob: files[i]!,
                createdAt: meta.createdAt,
              }),
            ),
          );
        } catch (err) {
          if (err instanceof ApiError) {
            if (err.status === 401) {
              onUnauthorized();
              return;
            }
            setActionError(err.detail);
          }
          return;
        }
      }

      // 2) Optimistic user message. Includes the attachment metadata so the
      //    bubble can render thumbnails immediately from IndexedDB.
      const tempId = `opt_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const now = new Date().toISOString();
      const visibleContent = content.trim();
      const sendContent =
        visibleContent || (uploadedMeta.length > 0 ? ATTACHMENT_ONLY_PROMPT : content);

      const optimistic: TimelineItem = {
        id: tempId,
        sessionId,
        turnId: null,
        type: "message",
        status: "pending",
        role: "user",
        content:
          uploadedMeta.length > 0
            ? { text: visibleContent, attachments: uploadedMeta }
            : { text: content },
        source: {},
        orderSeq: Number.MAX_SAFE_INTEGER,
        revision: 0,
        contentHash: "",
        updatedSeq: 0,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      setOptimisticItems((prev) => [...prev, optimistic]);
      try {
        const response = await api.sendSessionMessage(
          token,
          sessionId,
          sendContent,
          attachmentRefs,
          tempId,
        );
        const turnId =
          response.result &&
          typeof response.result === "object" &&
          "turnId" in response.result &&
          typeof response.result.turnId === "string"
            ? response.result.turnId
            : null;
        setOptimisticItems((prev) =>
          prev.map((m) =>
            m.id === tempId && m.status === "pending"
              ? { ...m, status: "running", turnId }
              : m,
          ),
        );
        setActionError(null);
      } catch (err) {
        // Roll back to a "failed" state so the user sees the message didn't
        // go through, but keep it visible (with the original text) so they
        // can re-type or copy it.
        setOptimisticItems((prev) =>
          prev.map((m) =>
            m.id === tempId ? { ...m, status: "failed" } : m,
          ),
        );
        if (err instanceof ApiError) {
          if (err.status === 401) onUnauthorized();
          else setActionError(err.detail);
        }
      }
    },
    [token, sessionId, onUnauthorized],
  );

  const sendWithRunModeGuard = useCallback(
    async (content: string, files: File[] = []) => {
      if (session.runtime === "claude" && !defaultRunModeConfigured) {
        setPendingRunModeSend({ content, files });
        setRunModePromptOpen(true);
        return;
      }
      await sendNow(content, files);
    },
    [session.runtime, defaultRunModeConfigured, sendNow],
  );

  const handleSend = useCallback(
    async (content: string, files: File[] = []) => {
      if (session.status === "error") {
        setPendingErrorSend({ content, files });
        return;
      }
      await sendWithRunModeGuard(content, files);
    },
    [session.status, sendWithRunModeGuard],
  );

  const confirmErrorSend = useCallback(async () => {
    const pending = pendingErrorSend;
    if (!pending) return;
    setPendingErrorSend(null);
    await sendWithRunModeGuard(pending.content, pending.files);
  }, [pendingErrorSend, sendWithRunModeGuard]);

  const handleInterrupt = useCallback(async () => {
    if (interrupting) return;
    setInterrupting(true);
    try {
      await api.interruptSession(token, sessionId);
      setActionError(null);
    } catch (err) {
      // Revert: button goes back to "stop" so the user can retry.
      setInterrupting(false);
      if (err instanceof ApiError) {
        if (err.status === 401) onUnauthorized();
        else setActionError(err.detail);
      }
    }
  }, [token, sessionId, interrupting, onUnauthorized]);

  const handleResolveApproval = useCallback(
    async (approvalId: string, status: ApprovalResolveStatus) => {
      if (resolvingApprovalId) return;
      setResolvingApprovalId(approvalId);
      setResolvingApprovalStatus(status);
      setExitingApprovalId(null);
      try {
        await api.resolveApproval(token, approvalId, status);
        setActionError(null);
        setExitingApprovalId(approvalId);
        await delay(180);
        setLocallyResolvedApprovalIds((prev) => new Set(prev).add(approvalId));
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.status === 401) onUnauthorized();
          else setActionError(err.detail);
        }
      } finally {
        setResolvingApprovalId(null);
        setResolvingApprovalStatus(null);
        setExitingApprovalId(null);
      }
    },
    [resolvingApprovalId, token, onUnauthorized],
  );

  const handlePatchRuntimeSettings = useCallback(
    async (patch: Record<string, unknown>) => {
      try {
        setRuntimeSettingsError(null);
        const res = await api.patchSessionRuntimeSettings(token, sessionId, patch);
        const effective = res.runtimeSettings ?? res.settings;
        setRuntimeSettings(effective);
        setDefaultRunModeConfigured(
          session.runtime !== "claude" || res.defaultRunModeConfigured,
        );
        onSessionRefreshed({
          ...session,
          effectiveRunMode: res.effectiveRunMode ?? session.effectiveRunMode,
          runtimeSettings: effective,
          runtimeSettingsOverride: res.runtimeSettingsOverride ?? null,
        });
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? err.detail
            : err instanceof Error
              ? err.message
              : "Failed to save runtime settings.";
        setRuntimeSettingsError(msg);
      }
    },
    [token, sessionId, session, onSessionRefreshed],
  );

  const handleChooseDefaultRunMode = useCallback(
    async (runMode: "chat" | "terminal") => {
      if (!connector) return;
      try {
        setRuntimeSettingsError(null);
        const res = await api.patchConnectorAgentSettings(
          token,
          connector.id,
          "claude",
          { runMode },
        );
        const effective = res.runtimeSettings ?? res.settings;
        setRuntimeSettings(effective);
        setDefaultRunModeConfigured(res.defaultRunModeConfigured);
        setRunModePromptOpen(false);
        const pending = pendingRunModeSend;
        setPendingRunModeSend(null);
        onSessionRefreshed({
          ...session,
          effectiveRunMode:
            runMode ?? res.effectiveRunMode ?? session.effectiveRunMode,
          runtimeSettings: effective,
        });
        if (pending) {
          await sendNow(pending.content, pending.files);
        }
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? err.detail
            : err instanceof Error
              ? err.message
              : "Failed to save runtime settings.";
        setRuntimeSettingsError(msg);
      }
    },
    [
      connector,
      token,
      pendingRunModeSend,
      session,
      onSessionRefreshed,
      sendNow,
    ],
  );

  // ─── Header ───────────────────────────────────────────────────────────
  const title = useMemo(() => titleFor(session, items), [session, items]);
  const workspace = useMemo(
    () => (session.cwd ? workspaceKey(session.cwd) : ""),
    [session.cwd],
  );

  const handleOpenFile = useCallback(
    (path: string) => {
      setPreviewFile({ name: path.split("/").pop() || path, path });
      setPoppedRuntime((prev) => ({ ...prev, preview: true }));
    },
    [],
  );

  const panel = runtimeLayout.panel;
  const isClaudeTerminalMode =
    session.runtime === "claude" && session.effectiveRunMode === "terminal";
  const hasFiles = panel === "files" || panel === "both";
  const hasTerm = panel === "term" || panel === "both";
  const hasPreview = previewFile !== null && !poppedRuntime.preview;
  const runtimeVisible =
    (hasFiles && !poppedRuntime.files) ||
    (hasTerm && !poppedRuntime.term) ||
    hasPreview;
  const closePoppedFiles = useCallback(() => {
    setPoppedRuntime((prev) => ({ ...prev, files: false }));
    runtimeLayout.setPanel(panel === "both" ? "term" : "none");
  }, [panel, runtimeLayout]);
  const closePoppedTerm = useCallback(() => {
    setPoppedRuntime((prev) => ({ ...prev, term: false }));
    runtimeLayout.setPanel(panel === "both" ? "files" : "none");
  }, [panel, runtimeLayout]);
  const closePoppedPreview = useCallback(() => {
    setPoppedRuntime((prev) => ({ ...prev, preview: false }));
    setPreviewFile(null);
  }, []);

  const filesEl =
    hasFiles && !poppedRuntime.files ? (
      <FilesPanel
        api={runtimeApi}
        onClose={() =>
          runtimeLayout.setPanel(panel === "both" ? "term" : "none")
        }
        onPickFile={(f) => {
          setPreviewFile(f);
          setPoppedRuntime((prev) => ({ ...prev, preview: true }));
        }}
        activeFile={previewFile}
        onPopOut={() => setPoppedRuntime((prev) => ({ ...prev, files: true }))}
      />
    ) : null;
  const previewEl =
    previewFile && !poppedRuntime.preview ? (
      <FilePreviewPanel
        api={runtimeApi}
        file={previewFile}
        onClose={() => setPreviewFile(null)}
        onPopOut={() =>
          setPoppedRuntime((prev) => ({ ...prev, preview: true }))
        }
      />
    ) : null;
  const termEl =
    hasTerm && !poppedRuntime.term ? (
      <TerminalPanel
        key={`terminal:${sessionId}`}
        api={runtimeApi}
        onClose={() =>
          runtimeLayout.setPanel(panel === "both" ? "files" : "none")
        }
        title="Shell"
        onPopOut={() => setPoppedRuntime((prev) => ({ ...prev, term: true }))}
      />
    ) : null;
  const poppedRuntimeEl =
    poppedRuntime.files ? (
      <RuntimeWindow
        title={`${title} - Files`}
        onClose={closePoppedFiles}
      >
        <FilesPanel
          api={runtimeApi}
          onClose={closePoppedFiles}
          onPickFile={(f) => {
            setPreviewFile(f);
            setPoppedRuntime((prev) => ({ ...prev, preview: true }));
          }}
          activeFile={previewFile}
          showClose
        />
      </RuntimeWindow>
    ) : null;
  const poppedTermEl = poppedRuntime.term ? (
      <RuntimeWindow
        title={`${title} - Shell`}
        onClose={closePoppedTerm}
      >
        <TerminalPanel
          key={`terminal-popout:${sessionId}`}
          api={runtimeApi}
          onClose={closePoppedTerm}
          title="Shell"
          showClose
        />
      </RuntimeWindow>
    ) : null;
  const poppedPreviewEl =
    poppedRuntime.preview && previewFile ? (
      <RuntimeWindow
        title={`${previewFile.name} - Preview`}
        onClose={closePoppedPreview}
      >
        <FilePreviewPanel
          api={runtimeApi}
          file={previewFile}
          onClose={closePoppedPreview}
        />
      </RuntimeWindow>
    ) : null;
  const primaryClaudeTermEl = (
    <div className="kl-claude-terminal-surface">
      <TerminalPanel
        key={`primary-claude-terminal:${sessionId}`}
        api={runtimeApi}
        onClose={() => undefined}
        primary
      />
    </div>
  );

  return (
    <div className="kl-sd-row">
      <div
        className={`kl-main-detail${sidebarCollapsed ? " sidebar-collapsed" : ""}`}
      >
        <SessionHeader
          title={title}
          session={session}
          runtime={session.runtime}
          connector={connector}
          connectorStatus={session.connectorStatus}
          workspace={workspace}
          items={items}
          approvals={state.approvals}
          nextSeq={state.nextSeq}
          runtimeSettings={runtimeSettings}
          panel={panel}
          hasPreview={hasPreview}
          onToggleFiles={runtimeLayout.togglePanelFiles}
          onToggleTerm={runtimeLayout.togglePanelTerm}
          effectiveRunMode={session.effectiveRunMode ?? null}
        />
        {isClaudeTerminalMode ? (
          primaryClaudeTermEl
        ) : (
          <>
            <Timeline
              items={items}
              approvalByTarget={approvalByTarget}
              loading={loadingFirstBatch}
              sessionId={sessionId}
              sessionStatus={session.status}
              runtime={session.runtime}
              onResolveApproval={handleResolveApproval}
              resolvingApprovalId={resolvingApprovalId}
              resolvingApprovalStatus={resolvingApprovalStatus}
              detachedApprovals={detachedApprovals}
              onOpenFile={handleOpenFile}
            />
            <Composer
              session={session}
              pendingApproval={pendingApproval ?? null}
              pendingApprovalCount={pendingApprovals.length}
              resolvingApprovalId={resolvingApprovalId}
              resolvingApprovalStatus={resolvingApprovalStatus}
              exitingApprovalId={exitingApprovalId}
              isBusy={isBusy}
              runtimeSettingsSchema={runtimeSettingsSchema}
              runtimeSettings={runtimeSettings}
              runtimeSettingsError={runtimeSettingsError}
              onPatchRuntimeSettings={handlePatchRuntimeSettings}
              takeoverInFlight={takeoverInFlight}
              onToggleTakeover={handleToggleTakeover}
              onSend={handleSend}
              onInterrupt={handleInterrupt}
              onResolveApproval={handleResolveApproval}
              actionError={actionError}
              onDismissError={() => setActionError(null)}
            />
            {takeoverConfirm && (
              <TakeoverConfirmModal
                mode={takeoverConfirm}
                busy={takeoverInFlight}
                onCancel={() => {
                  if (!takeoverInFlight) setTakeoverConfirm(null);
                }}
                onConfirm={applyTakeover}
              />
            )}
          </>
        )}
      </div>
      {runtimeVisible && (
        <RuntimePanel
          panel={panel}
          setPanel={runtimeLayout.setPanel}
          filesEl={filesEl}
          previewEl={previewEl}
          termEl={termEl}
          runtimeWidth={runtimeLayout.runtimeWidth}
          setRuntimeWidth={runtimeLayout.setRuntimeWidth}
          ratios={runtimeLayout.ratios}
          setRatio={runtimeLayout.setRatio}
        />
      )}
      {poppedRuntimeEl}
      {poppedTermEl}
      {poppedPreviewEl}
      {runModePromptOpen && (
        <SessionRunModePreviewModal
          value={runtimeSettings?.runMode === "terminal" ? "terminal" : "chat"}
          onSelect={handleChooseDefaultRunMode}
        />
      )}
      {pendingErrorSend && (
        <ConfirmModal
          title="Continue this errored session?"
          body="This session has an error. Sending another message may produce unexpected results."
          confirmLabel="Send anyway"
          onCancel={() => setPendingErrorSend(null)}
          onConfirm={confirmErrorSend}
        />
      )}
    </div>
  );
}

// ─── Header ────────────────────────────────────────────────────────────────

function SessionHeader({
  title,
  session,
  runtime,
  connector,
  connectorStatus,
  workspace,
  items,
  approvals,
  nextSeq,
  runtimeSettings,
  panel,
  hasPreview,
  onToggleFiles,
  onToggleTerm,
  effectiveRunMode,
}: {
  title: string;
  session: SessionView;
  runtime: string;
  connector: ConnectorView | null;
  connectorStatus: "online" | "offline";
  workspace: string;
  items: TimelineItem[];
  approvals: Approval[];
  nextSeq: number;
  runtimeSettings: Record<string, unknown> | null;
  panel: "none" | "files" | "term" | "both";
  hasPreview: boolean;
  onToggleFiles: () => void;
  onToggleTerm: () => void;
  effectiveRunMode: "chat" | "terminal" | null;
}) {
  const filesOn = panel === "files" || panel === "both";
  const termOn = panel === "term" || panel === "both";
  // Hide the secondary chips (Codex / device / workspace) whenever any
  // right-side runtime panel is open. Saves horizontal space so the title
  // and panel toggles fit without overlap. They come back when every panel
  // is closed.
  const showChips = panel === "none" && !hasPreview;
  return (
    <div className="kl-main-hd">
      <div className="kl-main-title-wrap">
        <div className="title" title={title}>
          {title}
        </div>
        <SessionRuntimeBadge
          session={session}
          runtime={runtime}
          connector={connector}
          connectorStatus={connectorStatus}
          workspace={workspace}
          items={items}
          approvals={approvals}
          nextSeq={nextSeq}
          runtimeSettings={runtimeSettings}
        />
      </div>
      <div className="chips">
        {showChips && (
          <>
            {runtime === "claude" && effectiveRunMode && (
              <span className="kl-chip">{effectiveRunMode === "terminal" ? "Terminal" : "Chat"}</span>
            )}
            {workspace && (
              <span className="kl-chip workspace">
                <Icons.Folder size={11} />
                {workspace.startsWith("/") ? workspace : `/${workspace}`}
              </span>
            )}
          </>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="toggle-files"
          className={`kl-sd-iconbtn${filesOn ? " on" : ""}`}
          title="Toggle Files panel"
          onClick={onToggleFiles}
        >
          <Icons.Files size={15} />
        </button>
        <button
          type="button"
          data-testid="toggle-term"
          className={`kl-sd-iconbtn${termOn ? " on" : ""}`}
          title="Toggle Terminal panel"
          onClick={onToggleTerm}
        >
          <Icons.Terminal size={15} />
        </button>
      </div>
    </div>
  );
}

function SessionRuntimeBadge({
  session,
  runtime,
  connector,
  connectorStatus,
  workspace,
  items,
  approvals,
  nextSeq,
  runtimeSettings,
}: {
  session: SessionView;
  runtime: string;
  connector: ConnectorView | null;
  connectorStatus: "online" | "offline";
  workspace: string;
  items: TimelineItem[];
  approvals: Approval[];
  nextSeq: number;
  runtimeSettings: Record<string, unknown> | null;
}) {
  const connectorName = connector?.name ?? "Unknown device";
  const isOnline = connectorStatus === "online";
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending").length;
  const agent = runtimeLabel(runtime);
  const label = `${connectorName}/${agent}`;
  const exportTimeline = useCallback(() => {
    const payload = {
      exportedAt: new Date().toISOString(),
      session,
      connector,
      runtime,
      runtimeSettings,
      nextSeq,
      items,
      approvals,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const safeTitle = (session.title || session.id).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-|-$/g, "");
    anchor.href = url;
    anchor.download = `${safeTitle || session.id}-timeline.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [approvals, connector, items, nextSeq, runtime, runtimeSettings, session]);

  return (
    <div className="kl-session-runtime" tabIndex={0}>
      <span className="kl-session-runtime-chip" title={label}>
        <span
          className="dot"
          style={{
            background: isOnline ? runtimeAccent(runtime) : "var(--text-faint)",
          } as CSSProperties}
        />
        {label}
      </span>
      <div className="kl-session-runtime-pop" role="tooltip">
        <div className="kl-session-runtime-pop-title">Session</div>
        <div className="kl-session-runtime-grid">
          <span>Device</span>
          <strong>{connectorName}</strong>
          <span>Agent</span>
          <strong>{agent}</strong>
          <span>Status</span>
          <strong>{session.status} · {connectorStatus}</strong>
          <span>Workspace</span>
          <strong title={session.cwd ?? ""}>{workspace || session.cwd || "Unknown"}</strong>
          <span>Session ID</span>
          <strong title={session.id}>{session.id}</strong>
          <span>External ID</span>
          <strong title={session.externalSessionId ?? ""}>{session.externalSessionId || "None"}</strong>
          <span>Timeline</span>
          <strong>{items.length} items · seq {nextSeq}</strong>
          <span>Approvals</span>
          <strong>{pendingApprovals} pending</strong>
        </div>
        <button type="button" className="kl-session-runtime-export" onClick={exportTimeline}>
          Export timeline JSON
        </button>
      </div>
    </div>
  );
}

function TakeoverConfirmModal({
  mode,
  busy,
  onCancel,
  onConfirm,
}: {
  mode: "enable" | "disable";
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const enabling = mode === "enable";
  return (
    <div className="kl-modal-backdrop" onClick={onCancel}>
      <div
        className="kl-modal kl-confirm kl-takeover-confirm"
        role="alertdialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <h3>{enabling ? "Enable takeover?" : "Disable takeover?"}</h3>
        <p>
          {enabling
            ? "Takeover makes this session writable from the web UI. Messages and interrupts will be sent to the remote agent."
            : "Disabling takeover returns this session to read-only mode. Existing agent work keeps running unless you interrupt it first."}
        </p>
        <div className="kl-modal-actions">
          <button
            type="button"
            className="kl-btn ghost"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="kl-btn primary"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy
              ? "Applying..."
              : enabling
                ? "Enable takeover"
                : "Disable takeover"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionRunModePreviewModal({
  value,
  onSelect,
}: {
  value: "chat" | "terminal";
  onSelect: (runMode: "chat" | "terminal") => void;
}) {
  const [draftValue, setDraftValue] = useState<"chat" | "terminal">(value);
  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  return (
    <div className="kl-modal-backdrop">
      <div
        className="kl-modal kl-runtime-config-modal guide-open kl-session-runmode-modal"
        role="dialog"
        aria-label="Choose Claude Code run mode first"
        onClick={(event) => event.stopPropagation()}
      >
        <RunModeGuide
          value={draftValue}
          disabled={false}
          title="Choose Claude Code run mode first"
          subtitle="This can affect how Claude Code usage is billed."
          showBack={false}
          showClose={false}
          onSelect={setDraftValue}
          onDone={() => onSelect(draftValue)}
        />
      </div>
    </div>
  );
}

// ─── Timeline ──────────────────────────────────────────────────────────────

function Timeline({
  items,
  approvalByTarget,
  loading,
  sessionId,
  sessionStatus,
  runtime,
  onResolveApproval,
  resolvingApprovalId,
  resolvingApprovalStatus,
  detachedApprovals,
  onOpenFile,
}: {
  items: TimelineItem[];
  approvalByTarget: Record<string, Approval>;
  loading: boolean;
  sessionId: string;
  sessionStatus: SessionView["status"];
  runtime: string;
  onResolveApproval: (id: string, status: ApprovalResolveStatus) => void;
  resolvingApprovalId: string | null;
  resolvingApprovalStatus: ApprovalResolveStatus | null;
  detachedApprovals: Approval[];
  onOpenFile?: (path: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const previousSessionRef = useRef<string | null>(null);
  const previousScrollHeightRef = useRef(0);
  const pinnedToBottomRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const lastItem = items.at(-1);
  const lastAssistantMessage = [...items]
    .reverse()
    .find((item) => item.type === "message" && item.role === "assistant");
  const streamingAssistantItemId =
    lastAssistantMessage && lastAssistantMessage.status === "running"
      ? lastAssistantMessage.id
      : null;
  const scrollKey = `${sessionId}:${items.length}:${lastItem?.id ?? ""}:${
    lastItem?.updatedSeq ?? 0
  }:${lastItem?.contentHash ?? ""}:${Object.keys(approvalByTarget).length}:${
    detachedApprovals.length
  }:${sessionStatus}`;

  // Codex emits multiple assistant `message` items within a single turn (one
  // per streaming chunk / continuation). The avatar+name header should only
  // appear on the first assistant message of each turn — subsequent ones in
  // the same turn render as continuation of the same reply.
  const hideAssistantHeaderIds = useMemo(() => {
    const seenTurns = new Set<string>();
    const hideIds = new Set<string>();
    for (const item of items) {
      if (item.type === "message" && item.role === "assistant" && item.turnId) {
        if (seenTurns.has(item.turnId)) {
          hideIds.add(item.id);
        } else {
          seenTurns.add(item.turnId);
        }
      }
    }
    return hideIds;
  }, [items]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const sessionChanged = previousSessionRef.current !== sessionId;
    const previousDistance = Math.max(
      0,
      previousScrollHeightRef.current - element.scrollTop - element.clientHeight,
    );
    const stickToBottom =
      sessionChanged ||
      previousScrollHeightRef.current === 0 ||
      previousDistance < 160 ||
      pinnedToBottomRef.current;

    if (stickToBottom) {
      pinnedToBottomRef.current = true;
      element.scrollTop = element.scrollHeight;
      setShowScrollToBottom(false);
      requestAnimationFrame(() => {
        element.scrollTop = element.scrollHeight;
        previousScrollHeightRef.current = element.scrollHeight;
        setShowScrollToBottom(false);
      });
    } else {
      previousScrollHeightRef.current = element.scrollHeight;
      pinnedToBottomRef.current = false;
      setShowScrollToBottom(
        element.scrollHeight - element.scrollTop - element.clientHeight > 120,
      );
    }
    previousSessionRef.current = sessionId;
  }, [scrollKey, sessionId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => {
      const distanceFromBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      pinnedToBottomRef.current = distanceFromBottom < 160;
      setShowScrollToBottom(distanceFromBottom > 120);
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    return () => element.removeEventListener("scroll", update);
  }, [sessionId]);

  const scrollToBottom = () => {
    const element = scrollRef.current;
    if (!element) return;
    pinnedToBottomRef.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    setShowScrollToBottom(false);
  };

  const keepBottomPinned = useCallback(() => {
    const element = scrollRef.current;
    if (!element || !pinnedToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
    previousScrollHeightRef.current = element.scrollHeight;
    setShowScrollToBottom(false);
  }, []);

  return (
    <div className="kl-msgs-shell">
      <div className="kl-msgs" ref={scrollRef}>
        <div className="kl-msgs-inner">
          {loading && items.length === 0 && <TimelineSkeleton />}
          {!loading && items.length === 0 && (
            <div className="kl-msgs-empty">No activity yet.</div>
          )}
          {items.map((item) => (
            <TimelineEntry
              key={item.id}
              item={item}
              approval={approvalByTarget[item.id]}
              onResolveApproval={onResolveApproval}
              resolvingApprovalId={resolvingApprovalId}
              resolvingApprovalStatus={resolvingApprovalStatus}
              hideAssistantHeader={hideAssistantHeaderIds.has(item.id)}
              smoothStreaming={item.id === streamingAssistantItemId}
              onStreamingFrame={keepBottomPinned}
              onOpenFile={onOpenFile}
            />
          ))}
          {detachedApprovals.map((approval) => (
            <DetachedApproval
              key={approval.id}
              approval={approval}
              onResolveApproval={onResolveApproval}
              resolvingApprovalId={resolvingApprovalId}
              resolvingApprovalStatus={resolvingApprovalStatus}
            />
          ))}
          {sessionStatus === "running" && (
            <div className="kl-streaming">
              <span className="pulse" />
              <span>{runtimeLabel(runtime)} is working…</span>
            </div>
          )}
        </div>
      </div>
      {showScrollToBottom && (
        <button
          type="button"
          className="kl-scroll-bottom"
          onClick={scrollToBottom}
          aria-label="Scroll to latest message"
          title="Scroll to latest"
        >
          <Icons.ChevDown size={18} />
        </button>
      )}
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <div className="kl-msgs-skel">
      <div className="kl-msgs-skel-block right">
        <div className="kl-skel kl-msgs-skel-line" style={{ width: "58%" }} />
        <div className="kl-skel kl-msgs-skel-meta" />
      </div>
      <div className="kl-msgs-skel-block">
        <div className="kl-skel kl-msgs-skel-meta" />
        <div className="kl-skel kl-msgs-skel-line" style={{ width: "88%" }} />
        <div className="kl-skel kl-msgs-skel-line" style={{ width: "72%" }} />
        <div className="kl-skel kl-msgs-skel-line" style={{ width: "44%" }} />
      </div>
      <div className="kl-msgs-skel-block">
        <div className="kl-skel kl-msgs-skel-meta" />
        <div className="kl-skel kl-msgs-skel-line" style={{ width: "78%" }} />
        <div className="kl-skel kl-msgs-skel-line" style={{ width: "54%" }} />
      </div>
    </div>
  );
}

function TimelineEntry({
  item,
  approval,
  onResolveApproval,
  resolvingApprovalId,
  resolvingApprovalStatus,
  hideAssistantHeader,
  smoothStreaming,
  onStreamingFrame,
  onOpenFile,
}: {
  item: TimelineItem;
  approval?: Approval;
  onResolveApproval: (id: string, status: ApprovalResolveStatus) => void;
  resolvingApprovalId: string | null;
  resolvingApprovalStatus: ApprovalResolveStatus | null;
  hideAssistantHeader?: boolean;
  smoothStreaming?: boolean;
  onStreamingFrame?: () => void;
  onOpenFile?: (path: string) => void;
}) {
  if (item.type === "message") {
    return (
      <MessageEntry
        item={item}
        hideAssistantHeader={hideAssistantHeader}
        smoothStreaming={smoothStreaming}
        onStreamingFrame={onStreamingFrame}
        onOpenFile={onOpenFile}
      />
    );
  }
  if (item.type === "tool") {
    return (
      <ToolEntry
        item={item}
        approval={approval}
        onResolveApproval={onResolveApproval}
        resolvingApprovalId={resolvingApprovalId}
        resolvingApprovalStatus={resolvingApprovalStatus}
      />
    );
  }
  if (item.type === "artifact") {
    // Codex emits a "turn diff" artifact alongside each apply_patch tool call.
    // The tool item already renders the same diff inline (EditToolCard), so
    // showing the artifact too would double-print. Hide it.
    const artifactKind = textOf(item.content.kind);
    if (artifactKind === "diff") return null;
    return (
      <div className="kl-notice">
        <Icons.GitBranch size={12} />
        <span className="pill">{artifactKind || "artifact"}</span>
        <em>{item.status}</em>
      </div>
    );
  }
  if (item.type === "system") {
    return <SystemEntry item={item} />;
  }
  // turn.start / turn.end — silent.
  return null;
}

function SystemEntry({ item }: { item: TimelineItem }) {
  const kind = textOf(item.content.kind) || "system";
  if (kind === "error" || item.status === "failed") {
    return <SystemErrorEntry item={item} kind={kind} />;
  }
  if (kind === "reasoning") {
    const summaries = recordsOf(item.content.summaries)
      .map((summary) => textOf(summary.text))
      .filter((text): text is string => Boolean(text));
    const rawText = textOf(item.content.rawText) || textOf(item.content.text);
    const lines = summaries.length > 0 ? summaries : rawText ? [rawText] : [];
    if (lines.length === 0) {
      return <SystemNotice kind={kind} message="Reasoning" />;
    }
    return (
      <div className="kl-system reasoning">
        <div className="kl-system-head">
          <Icons.Sparkle size={12} />
          <span>Reasoning</span>
        </div>
        <div className="kl-system-body">
          {lines.map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </div>
      </div>
    );
  }
  if (kind === "plan") {
    const steps = recordsOf(item.content.steps);
    const todos = recordsOf(item.content.todos);
    const entries =
      steps.length > 0
        ? steps.map((step) => ({
            text: textOf(step.text) || textOf(step.description) || "",
            status: textOf(step.status) || "pending",
          }))
        : todos.map((todo) => ({
            text: textOf(todo.content) || textOf(todo.text) || textOf(todo.description) || "",
            status: textOf(todo.status) || "pending",
          }));
    const explanation = textOf(item.content.explanation);
    const text = textOf(item.content.text);
    if (entries.length === 0 && !explanation && !text) {
      return <SystemNotice kind={kind} message="Plan updated" />;
    }
    return (
      <div className="kl-system plan">
        <div className="kl-system-head">
          <Icons.Check size={12} />
          <span>Plan</span>
        </div>
        <div className="kl-system-body">
          {explanation && <p>{explanation}</p>}
          {text && <p>{text}</p>}
          {entries.length > 0 && (
            <ul>
              {entries.map((entry, index) => (
                <li key={index}>
                  <span className={`plan-status ${entry.status}`} />
                  <span>{entry.text || "(empty step)"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }
  const message = textOf(item.content.message) || textOf(item.content.text) || safeJson(item.content);
  if (!message) return null;
  return <SystemNotice kind={kind} message={message} />;
}

function SystemNotice({ kind, message }: { kind: string; message: string }) {
  return (
    <div className="kl-notice">
      <Icons.AlertCircle size={12} />
      <span>{kind}</span>
      <em>{message}</em>
    </div>
  );
}

function SystemErrorEntry({ item, kind }: { item: TimelineItem; kind: string }) {
  const explicitMessage = textOf(item.content.message);
  const parsedMessage = explicitMessage ? parseJsonRecord(explicitMessage) : null;
  const details = recordOf(item.content.details) || parsedMessage;
  const nestedError = recordOf(details?.error) || recordOf(item.content.error);
  const message =
    textOf(nestedError?.message) ||
    textOf(item.content.error) ||
    (parsedMessage ? null : explicitMessage) ||
    textOf(item.content.text) ||
    "Runtime error";
  const code =
    textOf(item.content.code) ||
    textOf(nestedError?.code) ||
    textOf(nestedError?.type) ||
    kind;
  const extra =
    details || recordOf(item.content.error) || (parsedMessage ? parsedMessage : null);
  const detailText = extra ? safeJson(extra) : "";
  const retrying = Boolean(details?.willRetry) && /^Reconnecting\.\s+\d+\/\d+$/.test(message);
  if (retrying) {
    return (
      <div className="kl-notice err compact">
        <Icons.AlertCircle size={12} />
        <span>{code}</span>
        <em>{message}</em>
      </div>
    );
  }
  return (
    detailText ? (
      <details className="kl-system-details inline err">
        <summary>
          <span className="kl-notice err">
            <Icons.AlertCircle size={12} />
            <span>{code}</span>
            <em>{message}</em>
            <span className="kl-system-summary-label">Details</span>
          </span>
        </summary>
        <pre>{detailText}</pre>
      </details>
    ) : (
      <div className="kl-notice err">
        <Icons.AlertCircle size={12} />
        <span>{code}</span>
        <em>{message}</em>
      </div>
    )
  );
}

function MessageEntry({
  item,
  hideAssistantHeader,
  smoothStreaming,
  onStreamingFrame,
  onOpenFile,
}: {
  item: TimelineItem;
  hideAssistantHeader?: boolean;
  smoothStreaming?: boolean;
  onStreamingFrame?: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const text = textOf(item.content.text) ?? "";
  const time = formatTime(item.createdAt);
  const attachments = extractAttachments(item.content);
	  if (item.role === "user") {
	    const pending = item.status === "pending";
	    const failed = item.status === "failed";
	    const stateClass = failed
	      ? " failed"
	      : pending
	        ? " pending"
	        : "";
	    const stateLabel = failed
	      ? "Failed to send"
	      : pending
	        ? "Sending..."
	        : time;
    // When chips are shown, hide the machine-injected "[Attached file: …]"
    // mention the connector appends for codex — the chip says the same thing.
    const displayText =
      attachments.length > 0 ? stripInjectedAttachmentMentions(text) : text;
    return (
      <div className={`kl-msg user${stateClass}`}>
	        {attachments.length > 0 && (
	          <MessageAttachments sessionId={item.sessionId} attachments={attachments} />
	        )}
	        {displayText && <div className="bubble">{displayText}</div>}
	        {(pending || failed) && <div className="meta">{stateLabel}</div>}
	      </div>
	    );
	  }
  return (
    <div
      className={`kl-msg assistant${hideAssistantHeader ? " continuation" : ""}`}
    >
      <div className="text">
        {smoothStreaming ? (
          <StreamingMessageMarkdown
            text={text || "_(no content)_"}
            onOpenFile={onOpenFile}
            onFrame={onStreamingFrame}
          />
        ) : (
          <SessionMessageMarkdown text={text || "_(no content)_"} onOpenFile={onOpenFile} />
        )}
      </div>
    </div>
  );
}

function StreamingMessageMarkdown({
  text,
  onOpenFile,
  onFrame,
}: {
  text: string;
  onOpenFile?: (path: string) => void;
  onFrame?: () => void;
}) {
  const [displayText, setDisplayText] = useState("");
  const displayTextRef = useRef("");
  const targetTextRef = useRef(text);
  const lastRenderAtRef = useRef(0);

  useEffect(() => {
    targetTextRef.current = text;
    const current = displayTextRef.current;
    if (!text.startsWith(current) || current.length > text.length) {
      displayTextRef.current = text;
      setDisplayText(text);
      onFrame?.();
    }
  }, [text, onFrame]);

  useEffect(() => {
    let frameId = 0;
    let lastTs = 0;
    const tick = (ts: number) => {
      if (!lastTs) lastTs = ts;
      const current = displayTextRef.current;
      const target = targetTextRef.current;
      if (current !== target) {
        const backlog = target.length - current.length;
        if (backlog <= 0 || !target.startsWith(current)) {
          displayTextRef.current = target;
          setDisplayText(target);
          onFrame?.();
        } else {
          const elapsedSeconds = Math.max(0.012, (ts - lastTs) / 1000);
          const rate =
            backlog > 240
              ? STREAM_REVEAL_FAST_CHARS_PER_SECOND
              : STREAM_REVEAL_MIN_CHARS_PER_SECOND;
          const step = Math.max(1, Math.ceil(rate * elapsedSeconds));
          const next = target.slice(0, Math.min(target.length, current.length + step));
          displayTextRef.current = next;
          if (ts - lastRenderAtRef.current >= STREAM_MARKDOWN_MIN_INTERVAL_MS || next === target) {
            lastRenderAtRef.current = ts;
            setDisplayText(next);
            onFrame?.();
          }
        }
      }
      lastTs = ts;
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [onFrame]);

  return (
    <SessionMessageMarkdown
      text={displayText}
      onOpenFile={onOpenFile}
    />
  );
}

// ─── Tool entries ─────────────────────────────────────────────────────────

function ToolEntry({
  item,
  approval,
  onResolveApproval,
  resolvingApprovalId,
  resolvingApprovalStatus,
}: {
  item: TimelineItem;
  approval?: Approval;
  onResolveApproval: (id: string, status: ApprovalResolveStatus) => void;
  resolvingApprovalId: string | null;
  resolvingApprovalStatus: ApprovalResolveStatus | null;
}) {
  const kind = textOf(item.content.kind) || "tool";
  if (kind === "command") {
    return <BashToolCard item={item} />;
  }
  if (kind === "file_change") {
    return (
      <EditToolCard
        item={item}
        approval={approval}
        onResolveApproval={onResolveApproval}
        resolvingApprovalId={resolvingApprovalId}
        resolvingApprovalStatus={resolvingApprovalStatus}
      />
    );
  }
  if (kind === "web_search") {
    const action = recordOf(item.content.action);
    const url = action ? textOf(action.url) : "";
    return (
      <div className="kl-tool">
        <Icons.Globe size={11} />
        <span className="cmd-text">Searched web</span>
        <span className="target">
          {textOf(item.content.query) || url || "web activity"}
        </span>
        <span className={`status-pill ${item.status}`}>{item.status}</span>
      </div>
    );
  }
  if (kind === "mcp") {
    return <McpToolCard item={item} />;
  }
  const badgeLabel = kind === "generic" ? "Tool" : kind;
  return (
    <div className="kl-tool">
      <Icons.Code size={11} />
      <span className="badge">{badgeLabel}</span>
      <span className="target">{shortTitle(item)}</span>
      <span className={`status-pill ${item.status}`}>{item.status}</span>
    </div>
  );
}

function BashToolCard({ item }: { item: TimelineItem }) {
  const [open, setOpen] = useState(false);
  const command = commandText(item.content.command) || "command";
  const description = textOf(item.content.description) || command;
  const output =
    textOf(item.content.outputPreview) || textOf(item.content.outputText) || "";
  const isError = item.status === "failed" || item.status === "interrupted";
  return (
    <div
      className={`kl-tool-bash${open ? " open" : ""}${isError ? " err" : ""}`}
    >
      <button
        type="button"
        className="title"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="chev">
          <Icons.ChevRight size={12} />
        </span>
        {isError && (
          <span className="err-chip" aria-label="command failed">
            <span className="err-chip-dot" />
          </span>
        )}
        <span className="cmd-text">
          Ran <em>{description}</em>
        </span>
      </button>
      {open && (
        <div className="body">
          <div className="cmd-row">
            <div className="cmd" onWheel={scrollInlineOnWheel}>
              <span className="sigil">$</span>
              <span className="cmd-line">{command}</span>
            </div>
            <CopyButton text={command} label="Copy command" />
          </div>
          {output && (
            <div className="out-panel">
              <CopyButton text={output} label="Copy output" />
              <pre className="out">
                <AnsiText text={output} />
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function scrollInlineOnWheel(event: WheelEvent<HTMLDivElement>) {
  const el = event.currentTarget;
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  if (el.scrollWidth <= el.clientWidth) return;
  event.preventDefault();
  el.scrollLeft += event.deltaY;
}

function EditToolCard({
  item,
  approval,
  onResolveApproval,
  resolvingApprovalId,
  resolvingApprovalStatus,
}: {
  item: TimelineItem;
  approval?: Approval;
  onResolveApproval: (id: string, status: ApprovalResolveStatus) => void;
  resolvingApprovalId: string | null;
  resolvingApprovalStatus: ApprovalResolveStatus | null;
}) {
  const [open, setOpen] = useState(Boolean(approval));
  const changes = recordsOf(item.content.changes);
  const targetPath = changes[0] ? textOf(changes[0].path) : "";
  const filename = targetPath ? targetPath.split("/").pop() : "files";
  // Most-significant verb for the title chip. "add" wins over "update"/"delete"
  // because creating files is the most visually distinct event.
  const verbs = changes.map((c) => fileChangeVerb(c));
  const headVerb =
    verbs.find((v) => v === "Added") ??
    verbs.find((v) => v === "Deleted") ??
    verbs[0] ??
    (approval ? "Editing" : "Edited");
  return (
    <div className={`kl-edit${open ? " open" : ""}`}>
      <button
        type="button"
        className="title"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="chev">
          <Icons.ChevRight size={12} />
        </span>
        <span>
          {approval ? "Editing" : headVerb} <em>{filename}</em>
        </span>
        <span className="stat add">
          {changes.length} file{changes.length === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="body">
          {changes.length > 0 && (
            <div className="filelist">
              {changes.map((change, i) => (
                <div className="row" key={`${textOf(change.path) ?? ""}-${i}`}>
                  <span className="verb">{fileChangeVerb(change)}</span>
                  <span className="path-text">
                    {textOf(change.path) ?? "unknown path"}
                  </span>
                </div>
              ))}
            </div>
          )}
          {changes.map((change, i) => {
            const diff = textOf(change.diff);
            if (!diff) return null;
            return (
              <DiffBlock
                key={`diff-${textOf(change.path) ?? ""}-${i}`}
                diff={diff}
                added={fileChangeVerb(change) === "Added"}
              />
            );
          })}
          {approval && (
            <div style={{ padding: "10px 12px 12px" }}>
              <ApprovalButtons
                approval={approval}
                onResolveApproval={onResolveApproval}
                resolvingApprovalId={resolvingApprovalId}
                resolvingApprovalStatus={resolvingApprovalStatus}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// "Added" / "Edited" / "Deleted" / "Renamed" from the codex apply_patch
// change.kind shape: {type: "add" | "update" | "delete" | ..., move_path?: ...}
function fileChangeVerb(change: Record<string, unknown>): string {
  const kind = recordOf(change.kind);
  const type = kind ? textOf(kind.type) : null;
  if (type === "add") return "Added";
  if (type === "delete") return "Deleted";
  if (type === "update") {
    const movePath = kind ? textOf(kind.move_path) : null;
    return movePath ? "Renamed" : "Edited";
  }
  return "Changed";
}

// Tiny unified-diff renderer. `+` / `-` / `@@` lines get tinted; everything
// else is context. For "added" files codex sends raw content (no hunk header),
// which we just paint green. The `--- path` / `+++ path` (and `diff --git`,
// `index …`) header lines are dropped — they just repeat the path shown above
// and confuse readers; only the actual changed lines are kept.
const DIFF_HEADER_RE = /^(--- |\+\+\+ |diff --git |index )/;

function DiffBlock({ diff, added }: { diff: string; added: boolean }) {
  const lines = diff
    .replace(/\n$/, "")
    .split("\n")
    .filter((line) => !DIFF_HEADER_RE.test(line));
  return (
    <pre className="kl-diff">
      {lines.map((line, i) => {
        let cls: string;
        if (added) {
          // Whole-file new content (no per-line markers) — all additions.
          cls = "add";
        } else if (line.startsWith("@@")) {
          cls = "hunk";
        } else if (line.startsWith("+")) {
          cls = "add";
        } else if (line.startsWith("-")) {
          cls = "del";
        } else {
          cls = "ctx";
        }
        return (
          <span className={`ln ${cls}`} key={i}>
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

function McpToolCard({ item }: { item: TimelineItem }) {
  const [open, setOpen] = useState(false);
  const server = textOf(item.content.server) || "mcp";
  const tool = textOf(item.content.tool) || "tool";
  const args = recordOf(item.content.arguments);
  const error = textOf(item.content.error);
  const resultText = mcpResultText(
    item.content.result,
    item.content.outputText,
    item.content.text,
  );
  const isError =
    Boolean(error) ||
    item.status === "failed" ||
    item.status === "interrupted";
  return (
    <div
      className={`kl-tool-mcp${open ? " open" : ""}${isError ? " err" : ""}`}
    >
      <button
        type="button"
        className="title"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="chev">
          <Icons.ChevRight size={12} />
        </span>
        <span className="badge">MCP</span>
        <span className="target">
          <em>{server}</em>
          <span className="sep">·</span>
          {tool}
        </span>
        <span className={`status-pill ${item.status}`}>{item.status}</span>
      </button>
      {open && (
        <div className="body">
          {args && Object.keys(args).length > 0 && (
            <>
              <div className="label">Arguments</div>
              <pre className="json">{safeJson(args)}</pre>
            </>
          )}
          {resultText && (
            <>
              <div className="label">Result</div>
              <pre className="out">{resultText}</pre>
            </>
          )}
          {error && (
            <>
              <div className="label err">Error</div>
              <pre className="out err">{error}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Codex MCP results are MCP-protocol shaped: { content: [{ type, text }],
// structuredContent, _meta }. Claude results may be a raw text block array or
// string, with outputText/text already normalized by the reducer.
function mcpResultText(result: unknown, ...fallbacks: unknown[]): string {
  const fallback = fallbacks.map(textOf).find((text) => text && text.length > 0);
  if (Array.isArray(result)) {
    const texts = result
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .filter(Boolean);
    if (texts.length > 0) return texts.join("\n");
    return fallback || "";
  }
  if (typeof result === "string") return result;
  const record = recordOf(result);
  if (!record) return fallback || "";
  const content = record.content;
  if (Array.isArray(content)) {
    const texts = content
      .map((c) => {
        if (typeof c === "string") return c;
        if (!c || typeof c !== "object") return "";
        const text = (c as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .filter(Boolean);
    if (texts.length > 0) return texts.join("\n");
  }
  const structured = record.structuredContent;
  if (structured != null) return safeJson(structured);
  return fallback || "";
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}



function DetachedApproval({
  approval,
  onResolveApproval,
  resolvingApprovalId,
  resolvingApprovalStatus,
}: {
  approval: Approval;
  onResolveApproval: (id: string, status: ApprovalResolveStatus) => void;
  resolvingApprovalId: string | null;
  resolvingApprovalStatus: ApprovalResolveStatus | null;
}) {
  return (
    <div className="kl-edit open">
      <div className="title">
        <Icons.Shield size={12} />
        <span>{approval.title || "Approval requested"}</span>
      </div>
      <div className="body">
        {approval.description && (
          <div
            className="filelist"
            style={{ whiteSpace: "pre-wrap" } as CSSProperties}
          >
            {approval.description}
          </div>
        )}
        <div style={{ padding: "10px 12px 12px" }}>
          <ApprovalButtons
            approval={approval}
            onResolveApproval={onResolveApproval}
            resolvingApprovalId={resolvingApprovalId}
            resolvingApprovalStatus={resolvingApprovalStatus}
          />
        </div>
      </div>
    </div>
  );
}

function ApprovalButtons({
  approval,
  onResolveApproval,
  resolvingApprovalId,
  resolvingApprovalStatus,
}: {
  approval: Approval;
  onResolveApproval: (id: string, status: ApprovalResolveStatus) => void;
  resolvingApprovalId: string | null;
  resolvingApprovalStatus: ApprovalResolveStatus | null;
}) {
  if (approval.status !== "pending") {
    return (
      <div className="kl-notice">
        <Icons.Check size={12} />
        <em>{approval.status.replace("_", " ")}</em>
      </div>
    );
  }
  const resolving = resolvingApprovalId === approval.id;
  const disabled = resolvingApprovalId !== null;
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <button
        className="kl-btn ghost"
        disabled={disabled}
        onClick={() => onResolveApproval(approval.id, "rejected")}
      >
        {resolving && resolvingApprovalStatus === "rejected" ? (
          <Icons.Loader size={12} className="spin" />
        ) : null}
        Deny
      </button>
      <button
        className="kl-btn ghost"
        disabled={disabled}
        onClick={() => onResolveApproval(approval.id, "approved_for_session")}
      >
        {resolving && resolvingApprovalStatus === "approved_for_session" ? (
          <Icons.Loader size={12} className="spin" />
        ) : null}
        Always allow
      </button>
      <button
        className="kl-btn primary"
        disabled={disabled}
        onClick={() => onResolveApproval(approval.id, "approved")}
      >
        {resolving && resolvingApprovalStatus === "approved" ? (
          <Icons.Loader size={12} className="spin" />
        ) : null}
        Allow once
      </button>
    </div>
  );
}

// ─── Composer ─────────────────────────────────────────────────────────────

// Hard caps mirror the backend's MAX_UPLOAD_* constants; surfaced here so the
// composer rejects obvious mistakes before paying the round-trip.
const MAX_ATTACHMENT_FILES = 5;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_ONLY_PROMPT = "(No text content.)";

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
const COMPOSER_MENU_MARGIN = 8;
const COMPOSER_MENU_GAP = 8;

type ComposerMenuItem = {
  id: string;
  label: string;
  tier?: string;
  description?: string | null;
};

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
  const spaceAbove = Math.max(
    0,
    rect.top - COMPOSER_MENU_MARGIN - COMPOSER_MENU_GAP,
  );
  const spaceBelow = Math.max(
    0,
    viewportHeight - rect.bottom - COMPOSER_MENU_MARGIN - COMPOSER_MENU_GAP,
  );
  const placeAbove =
    spaceAbove >= estimatedHeight || spaceAbove > spaceBelow;
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

function composerSubmenuStyle(
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
  const maxHeight = Math.max(120, viewportHeight - COMPOSER_MENU_MARGIN * 2);
  const height = Math.min(estimatedHeight, maxHeight);
  const left = rect.right + COMPOSER_MENU_GAP;
  const top = Math.min(
    Math.max(COMPOSER_MENU_MARGIN, rect.top - 4),
    Math.max(COMPOSER_MENU_MARGIN, viewportHeight - height - COMPOSER_MENU_MARGIN),
  );
  return { top, left, width, maxHeight };
}

function Composer({
  session,
  pendingApproval,
  pendingApprovalCount,
  resolvingApprovalId,
  resolvingApprovalStatus,
  exitingApprovalId,
  isBusy,
  runtimeSettingsSchema,
  runtimeSettings,
  runtimeSettingsError,
  onPatchRuntimeSettings,
  takeoverInFlight,
  onToggleTakeover,
  onSend,
  onInterrupt,
  onResolveApproval,
  actionError,
  onDismissError,
}: {
  session: SessionView;
  pendingApproval: Approval | null;
  pendingApprovalCount: number;
  resolvingApprovalId: string | null;
  resolvingApprovalStatus: ApprovalResolveStatus | null;
  exitingApprovalId: string | null;
  isBusy: boolean;
  runtimeSettingsSchema: RuntimeConfigSchema | null;
  runtimeSettings: Record<string, unknown> | null;
  runtimeSettingsError: string | null;
  onPatchRuntimeSettings: (settings: Record<string, unknown>) => void;
  takeoverInFlight: boolean;
  onToggleTakeover: () => void;
  onSend: (content: string, files: File[]) => void;
  onInterrupt: () => void;
  onResolveApproval: (id: string, status: ApprovalResolveStatus) => void;
  actionError: string | null;
  onDismissError: () => void;
}) {
  const runtime = session.runtime;
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [filePreviewUrls, setFilePreviewUrls] = useState<Record<number, string>>(
    {},
  );
  const [modeAnchor, setModeAnchor] = useState<HTMLElement | null>(null);
  const [tuningAnchor, setTuningAnchor] = useState<HTMLElement | null>(null);
  const [permissionVisible, setPermissionVisible] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);
  const settingsFields = runtimeConfigFields(
    runtimeSettingsSchema,
    runtimeSettings,
    "session",
  );
  const permissionField = settingsFields.find((field) => field.key === "permissionMode");
  const modelField = settingsFields.find((field) => field.key === "model");
  const rawEffortField = settingsFields.find((field) => field.key === "effort");
  const effortField = filterClaudeEffortField(
    runtime,
    rawEffortField,
    runtimeSettings?.model,
  );
  const selectorFields = [permissionField, modelField, effortField].filter(
    (field): field is RuntimeConfigField => Boolean(field),
  );

  // Per-file object URLs for chip previews. Stored by index in the current
  // `files` array — released as soon as the file is removed or the message is
  // sent, so the composer doesn't leak between sends.
  useEffect(() => {
    const next: Record<number, string> = {};
    files.forEach((f, i) => {
      if (f.type.startsWith("image/")) next[i] = URL.createObjectURL(f);
    });
    setFilePreviewUrls(next);
    return () => {
      Object.values(next).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [files]);

  const hasSelectors = selectorFields.length > 0;

  // Re-open the panel whenever a new pending approval arrives.
  const lastApprovalIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingApproval?.id ?? null;
    if (id && id !== lastApprovalIdRef.current) {
      setPermissionVisible(true);
      lastApprovalIdRef.current = id;
    } else if (!id) {
      lastApprovalIdRef.current = null;
    }
  }, [pendingApproval]);

  const connectorOnline = session.connectorStatus === "online";
  const canSend =
    connectorOnline &&
    session.takeover &&
    (session.status === "idle" || session.status === "error");

  const placeholder = !session.takeover
    ? "Read-only — turn on Takeover to send messages"
    : !connectorOnline
      ? "Device is offline"
      : pendingApproval
        ? "Waiting for your approval above…"
        : isBusy
          ? "Send an interrupt or wait for the current turn to finish"
          : session.status === "error"
            ? "This session has an error; sending will ask for confirmation"
            : "Reply, or interrupt with new instructions…";

  const autosize = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  };

  const handleSubmit = () => {
    const trimmed = value.trim();
    // Attachments without text are allowed — e.g. "look at this screenshot".
    if (!canSend || (!trimmed && files.length === 0)) return;
    onSend(trimmed, files);
    setValue("");
    setFiles([]);
    setAttachmentError(null);
    requestAnimationFrame(() => autosize(textareaRef.current));
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
    if (rejected) onDismissError();
  };

  const handleFilesPicked = (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    addFiles(picked);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
    setAttachmentError(null);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!session.takeover || !connectorOnline) return;
    const images = clipboardImageFiles(event.clipboardData);
    if (images.length === 0) return;
    event.preventDefault();
    addFiles(images);
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!session.takeover || !connectorOnline) return;
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDraggingFiles(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!session.takeover || !connectorOnline) return;
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
    if (!session.takeover || !connectorOnline) return;
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDraggingFiles(false);
    addFiles(event.dataTransfer.files);
  };

  const hasInput = value.trim().length > 0 || files.length > 0;
  const sendDisabled = !canSend || !hasInput;
  const showInterrupt = isBusy && !hasInput;
  const permissionLabel = optionLabel(
    permissionField,
    runtimeSettings?.permissionMode,
    "Permission mode",
  );
  const modelLabel = optionLabel(modelField, runtimeSettings?.model, "Model");
  const effortLabel = optionLabel(effortField, runtimeSettings?.effort, "Effort");
  const hasTuningSelector = Boolean(modelField || effortField);
  const toggleModeMenu = (anchorEl: HTMLElement) => {
    setTuningAnchor(null);
    setModeAnchor((prev) => (prev === anchorEl ? null : anchorEl));
  };
  const toggleTuningMenu = (anchorEl: HTMLElement) => {
    setModeAnchor(null);
    setTuningAnchor((prev) => (prev === anchorEl ? null : anchorEl));
  };

  return (
    <div className="kl-comp-wrap">
      {pendingApproval && permissionVisible && (
        <PermissionRequest
          approval={pendingApproval}
          pendingCount={pendingApprovalCount}
          resolvingApprovalId={resolvingApprovalId}
          resolvingApprovalStatus={resolvingApprovalStatus}
          exiting={exitingApprovalId === pendingApproval.id}
          onResolveApproval={onResolveApproval}
          onHide={() => setPermissionVisible(false)}
        />
      )}
      {actionError && (
        <div className="kl-comp-banner" onClick={onDismissError}>
          {actionError} (click to dismiss)
        </div>
      )}
      <div
        className={`kl-comp${draggingFiles ? " dragging" : ""}`}
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
                  <img
                    className="kl-comp-chip-thumb"
                    src={filePreviewUrls[idx]}
                    alt=""
                  />
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
        {attachmentError && (
          <div className="kl-comp-attach-error">{attachmentError}</div>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            autosize(e.currentTarget);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            // Plain Enter sends; Shift+Enter inserts a newline. ⌘/Ctrl+Enter
            // also sends for muscle memory from the old shortcut.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={!session.takeover || !connectorOnline}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => handleFilesPicked(e.currentTarget.files)}
          accept="image/*,application/pdf,text/*,.md,.csv,.json,.xml,.yaml,.yml,.log"
        />
        <div className="kl-comp-row">
          {pendingApproval && (
            <button
              type="button"
              className={`kl-comp-sel kl-perm-btn${permissionVisible ? " on" : ""}`}
              onClick={() => setPermissionVisible((v) => !v)}
              title={
                permissionVisible
                  ? "Hide permission request"
                  : "Show permission request"
              }
            >
              <Icons.Shield size={13} />
              {!permissionVisible && <span className="badge-dot" />}
            </button>
          )}
          <button
            type="button"
            className="kl-comp-sel"
            title={
              files.length >= MAX_ATTACHMENT_FILES
                ? `Up to ${MAX_ATTACHMENT_FILES} files`
                : "Attach files"
            }
            disabled={
              !session.takeover ||
              !connectorOnline ||
              files.length >= MAX_ATTACHMENT_FILES
            }
            onClick={() => fileInputRef.current?.click()}
          >
            <Icons.Paperclip size={14} />
          </button>
          {hasSelectors && (
            <>
              {permissionField && (
                <button
                  type="button"
                  className="kl-comp-sel"
                  disabled={!runtimeSettings}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleModeMenu(e.currentTarget);
                  }}
                  onClick={(e) => {
                    if (e.detail === 0) toggleModeMenu(e.currentTarget);
                  }}
                >
                  <span
                    className="dot"
                    style={{ background: runtimeAccent(runtime) } as CSSProperties}
                  />
                  {permissionLabel}
                  <Icons.ChevDown size={11} />
                </button>
              )}
              {hasTuningSelector && (
                <button
                  type="button"
                  className="kl-comp-sel kl-comp-tuning-sel"
                  disabled={!runtimeSettings}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleTuningMenu(e.currentTarget);
                  }}
                  onClick={(e) => {
                    if (e.detail === 0) toggleTuningMenu(e.currentTarget);
                  }}
                >
                  {effortField && <span className="tier">{effortLabel}</span>}
                  {effortField && modelField && (
                    <span className="kl-comp-sel-dotsep" />
                  )}
                  {modelField && <span>{modelLabel}</span>}
                  <Icons.ChevDown size={11} />
                </button>
              )}
            </>
          )}
          <button
            type="button"
            className={`kl-takeover kl-comp-takeover${session.takeover ? " on" : ""}`}
            onClick={onToggleTakeover}
            disabled={takeoverInFlight || !connectorOnline}
            title={
              !connectorOnline
                ? "Device is offline"
                : session.takeover
                  ? "Takeover on — you can send messages"
                  : "Takeover off — read-only"
            }
          >
            <span className="track" />
            Takeover
          </button>
          <span className="sep" />
          {showInterrupt ? (
            <button
              type="button"
              className="kl-send interrupt"
              onClick={onInterrupt}
              title="Interrupt the current turn"
            >
              <Icons.Stop size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="kl-send"
              disabled={sendDisabled}
              onClick={handleSubmit}
              title="Send (↵) — Shift+↵ for newline"
            >
              <Icons.ArrowUp size={14} />
            </button>
          )}
        </div>
      </div>
      {modeAnchor && (
        <ComposerMenu
          anchor={modeAnchor}
          title="Permission mode"
          items={toComposerMenuItems(permissionField)}
          value={stringSetting(runtimeSettings?.permissionMode)}
          onChange={(value) => onPatchRuntimeSettings({ permissionMode: value })}
          onClose={() => setModeAnchor(null)}
        />
      )}
      {tuningAnchor && (
        <ModelEffortMenu
          anchor={tuningAnchor}
          effortItems={toComposerMenuItems(effortField)}
          effortValue={effectiveFieldValue(effortField, runtimeSettings?.effort)}
          modelItems={toComposerMenuItems(modelField)}
          modelValue={effectiveFieldValue(modelField, runtimeSettings?.model)}
          onChangeEffort={(value) => onPatchRuntimeSettings({ effort: value })}
          onChangeModel={(value) => onPatchRuntimeSettings({ model: value })}
          onClose={() => setTuningAnchor(null)}
        />
      )}
      {runtimeSettingsError && (
        <div className="kl-comp-runtime-error">{runtimeSettingsError}</div>
      )}
    </div>
  );
}

function ComposerMenu({
  anchor,
  title,
  titleKeys,
  items,
  value,
  onChange,
  onClose,
}: {
  anchor: HTMLElement;
  title: string;
  titleKeys?: string[];
  items: ComposerMenuItem[];
  value: string;
  onChange: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);
  const W = 240;
  const itemHeight = 36;
  const style = composerMenuStyle(anchor, W, 44 + items.length * itemHeight);
  return (
    <div
      ref={ref}
      className="kl-comp-menu"
      style={style}
    >
      <div className="kl-comp-menu-hd">
        <span>{title}</span>
        {titleKeys && (
          <span className="keys">
            {titleKeys.map((k, i) => (
              <kbd key={i}>{k}</kbd>
            ))}
          </span>
        )}
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          className={`item${value === item.id ? " on" : ""}`}
          onClick={() => {
            onChange(item.id);
            onClose();
          }}
        >
          <span className="lbl">
            <span>
              {item.label}
              {item.tier && <span className="tier"> {item.tier}</span>}
            </span>
          </span>
          <span className="check">
            <Icons.Check size={11} />
          </span>
        </div>
      ))}
    </div>
  );
}

function ModelEffortMenu({
  anchor,
  effortItems,
  effortValue,
  modelItems,
  modelValue,
  onChangeEffort,
  onChangeModel,
  onClose,
}: {
  anchor: HTMLElement;
  effortItems: ComposerMenuItem[];
  effortValue: string;
  modelItems: ComposerMenuItem[];
  modelValue: string;
  onChangeEffort: (id: string) => void;
  onChangeModel: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const modelRef = useRef<HTMLDivElement | null>(null);
  const modelButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeModelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const cancelCloseModel = () => {
    if (!closeModelTimerRef.current) return;
    clearTimeout(closeModelTimerRef.current);
    closeModelTimerRef.current = null;
  };
  const closeModelSoon = () => {
    cancelCloseModel();
    closeModelTimerRef.current = setTimeout(() => {
      setModelOpen(false);
      closeModelTimerRef.current = null;
    }, 100);
  };
  useEffect(() => () => cancelCloseModel(), []);
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        ref.current?.contains(target) ||
        modelRef.current?.contains(target) ||
        anchor.contains(target)
      ) {
        return;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  const hasEffort = effortItems.length > 0;
  const hasModels = modelItems.length > 0;
  const selectedModel =
    modelItems.find((item) => item.id === modelValue) ?? modelItems[0] ?? null;
  const separatorHeight = hasEffort && hasModels ? 13 : 0;
  const rowCount = effortItems.length + (selectedModel ? 1 : 0);
  const style = composerMenuStyle(
    anchor,
    216,
    8 + (hasEffort ? 32 : 0) + separatorHeight + rowCount * 36,
  );
  const modelStyle =
    modelOpen && modelButtonRef.current
      ? composerSubmenuStyle(
          modelButtonRef.current,
          192,
          44 + modelItems.length * 36,
        )
      : null;

  return (
    <>
      <div
        ref={ref}
        className="kl-comp-menu kl-comp-tuning-menu"
        style={style}
        onPointerEnter={cancelCloseModel}
        onPointerLeave={closeModelSoon}
      >
        {hasEffort && (
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
                  onChangeEffort(item.id);
                  onClose();
                }}
              >
                <span>{item.label}</span>
                <Icons.Check size={13} />
              </button>
            ))}
          </>
        )}
        {hasEffort && selectedModel && <div className="kl-comp-menu-sep" />}
        {selectedModel && (
          <button
            ref={modelButtonRef}
            type="button"
            className={`kl-comp-menu-row model${modelOpen ? " active" : ""}`}
            onPointerEnter={() => {
              cancelCloseModel();
              setModelOpen(true);
            }}
            onClick={() => {
              cancelCloseModel();
              setModelOpen(true);
            }}
          >
            <span>{selectedModel.label}</span>
            <Icons.ChevRight size={14} />
          </button>
        )}
      </div>
      {modelOpen && hasModels && modelStyle && (
        <div
          ref={modelRef}
          className="kl-comp-menu kl-comp-model-menu"
          style={modelStyle}
          onPointerEnter={cancelCloseModel}
          onPointerLeave={closeModelSoon}
        >
          <div className="kl-comp-menu-hd">
            <span>Model</span>
          </div>
          {modelItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`kl-comp-menu-row${modelValue === item.id ? " on" : ""}`}
              onClick={() => {
                onChangeModel(item.id);
                onClose();
              }}
            >
              <span>{item.label}</span>
              <Icons.Check size={13} />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function toComposerMenuItems(
  field: RuntimeConfigField | null | undefined,
): ComposerMenuItem[] {
  return (
    field?.options?.map((option) => ({
      id: String(option.value),
      label: option.label,
    })) ?? []
  );
}

function stringSetting(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function effectiveFieldValue(
  field: RuntimeConfigField | null | undefined,
  value: unknown,
): string {
  return stringSetting(value) || String(field?.options?.[0]?.value ?? "");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function PermissionRequest({
  approval,
  pendingCount,
  resolvingApprovalId,
  resolvingApprovalStatus,
  exiting,
  onResolveApproval,
  onHide,
}: {
  approval: Approval;
  pendingCount: number;
  resolvingApprovalId: string | null;
  resolvingApprovalStatus: ApprovalResolveStatus | null;
  exiting: boolean;
  onResolveApproval: (id: string, status: ApprovalResolveStatus) => void;
  onHide: () => void;
}) {
  const verb = approvalVerb(approval);
  const target = approvalTarget(approval);
  return (
    <div className={`kl-permission${exiting ? " exiting" : ""}`}>
      <div className="hd">
        <span className="dot" />
        <span className="q">
          Allow this agent to {verb}
          {target && (
            <>
              {" "}
              <em>{target}</em>
            </>
          )}
          ?
        </span>
        <span className="queue">
          {pendingCount > 1 ? `1/${pendingCount} waiting` : "1 waiting"}
        </span>
        <span className="scope">{approval.kind.replace("_", " ")}</span>
        <button type="button" className="x" onClick={onHide} aria-label="Hide">
          <Icons.X size={13} />
        </button>
      </div>
      {approval.description && (
        <div className="desc-box">{approval.description}</div>
      )}
      <div className="actions">
        <button
          className="kl-btn ghost deny"
          disabled={resolvingApprovalId !== null}
          onClick={() => onResolveApproval(approval.id, "rejected")}
        >
          {resolvingApprovalId === approval.id && resolvingApprovalStatus === "rejected" ? (
            <Icons.Loader size={12} className="spin" />
          ) : null}
          Deny
        </button>
        <button
          className="kl-btn ghost"
          disabled={resolvingApprovalId !== null}
          onClick={() => onResolveApproval(approval.id, "approved_for_session")}
        >
          {resolvingApprovalId === approval.id &&
          resolvingApprovalStatus === "approved_for_session" ? (
            <Icons.Loader size={12} className="spin" />
          ) : null}
          Always allow
        </button>
        <button
          className="kl-btn primary"
          disabled={resolvingApprovalId !== null}
          onClick={() => onResolveApproval(approval.id, "approved")}
        >
          {resolvingApprovalId === approval.id && resolvingApprovalStatus === "approved" ? (
            <Icons.Loader size={12} className="spin" />
          ) : null}
          Allow once <span className="keybind">⌘↵</span>
        </button>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function titleFor(session: SessionView, items: TimelineItem[]): string {
  if (session.title && session.title.trim()) return session.title;
  const firstUser = items.find(
    (it) => it.type === "message" && it.role === "user",
  );
  if (firstUser) {
    const text = textOf(firstUser.content.text) ?? "";
    const oneLine = text.split(/\r?\n/, 1)[0] ?? "";
    if (oneLine.trim()) return truncate(oneLine.trim(), 90);
  }
  return `Session ${session.id.slice(0, 8)}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function textOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return recordOf(JSON.parse(value));
  } catch {
    return null;
  }
}

function recordsOf(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is Record<string, unknown> =>
      v != null && typeof v === "object" && !Array.isArray(v),
  );
}

function commandText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => String(v)).join(" ");
  return "";
}

function shortTitle(item: TimelineItem): string {
  const fn = textOf(item.content.function);
  if (fn) return fn;
  const name = textOf(item.content.name);
  if (name) return name;
  const tool = textOf(item.content.tool);
  if (tool) return tool;
  return textOf(item.content.kind) ?? "tool";
}

function approvalVerb(approval: Approval): string {
  switch (approval.kind) {
    case "command":
      return "run this command";
    case "file_change":
      return "edit";
    case "permission":
      return "grant this permission";
    case "tool_call":
      return "use this tool";
    case "input_request":
      return "ask for input";
    default:
      return "proceed";
  }
}

function approvalTarget(approval: Approval): string {
  const payload = recordOf(approval.payload);
  if (!payload) return "";
  const direct = textOf(payload.path);
  if (direct) return direct.split("/").pop() ?? direct;
  const command = textOf(payload.command);
  if (command) return truncate(command, 50);
  const changes = recordsOf(payload.changes);
  if (changes.length > 0) {
    const path = textOf(changes[0]!.path);
    if (path) return path.split("/").pop() ?? path;
  }
  const tool = textOf(payload.tool);
  if (tool) return tool;
  return "";
}
