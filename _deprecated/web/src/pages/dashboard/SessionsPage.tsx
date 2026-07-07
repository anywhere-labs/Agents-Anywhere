import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMatch, useNavigate, useSearchParams } from "react-router-dom";
import {
  ApiError,
  api,
  type AuthMe,
  type ConnectorRevokeResponse,
  type ConnectorView,
  type DashboardEvent,
  type SessionView,
  type TimelineItem,
} from "../../lib/api";
import { runtimeLabel } from "../../lib/runtime";
import type { Theme } from "../../lib/theme";
import { Icons } from "../../components/Icons";
import { Sidebar, workspaceKey } from "./Sidebar";
import { SessionDetailView } from "./SessionDetailView";
import { TeamPage } from "./TeamPage";
import { ServicePage } from "./ServicePage";
import { SettingsPage } from "./SettingsPage";
import { DevicePage } from "./DevicePage";
import { WorkspacePage } from "./WorkspacePage";
import { PairDeviceModal } from "./PairDeviceModal";
import { NewSessionPage } from "./NewSessionPage";
import { SessionRowMenu } from "./SessionRowMenu";
import { RenameSessionModal } from "./RenameSessionModal";
import { ConfirmModal } from "./ConfirmModal";
import {
  FILTER_DEFAULTS,
  FilterMenu,
  type FilterKey,
  type FilterOption,
  type FilterState,
} from "./FilterMenu";
import "./dashboard.css";

type SessionsPageProps = {
  token: string;
  initialMe: AuthMe;
  theme: Theme;
  onSetTheme: (theme: Theme) => void;
  onSignOut: () => void;
};

type PairingState =
  | false
  | { credential?: ConnectorRevokeResponse | null; title?: string };
const DASHBOARD_RETRY_SYNC_MS = 10000;
const HOVER_CLOSE_DELAY_MS = 180;
const ONBOARD_STORAGE_PREFIX = "agents-anywhere:onboarded:";

function fresherSession(existing: SessionView | undefined, incoming: SessionView) {
  if (!existing) return incoming;
  return incoming.updatedSeq < existing.updatedSeq ? existing : incoming;
}

function sortSessions(sessions: SessionView[]): SessionView[] {
  return [...sessions].sort((a, b) => {
    const sortAt = (b.sortAt ?? "").localeCompare(a.sortAt ?? "");
    if (sortAt !== 0) return sortAt;
    const orderSeq = (b.lastItemOrderSeq ?? -1) - (a.lastItemOrderSeq ?? -1);
    if (orderSeq !== 0) return orderSeq;
    return b.updatedSeq - a.updatedSeq;
  });
}

function mergeSessionList(
  existing: SessionView[],
  incoming: SessionView[],
): SessionView[] {
  const byId = new Map(existing.map((session) => [session.id, session]));
  return sortSessions(
    incoming.map((session) => fresherSession(byId.get(session.id), session)),
  );
}

function mergeSessionPatches(
  existing: SessionView[],
  incoming: SessionView[],
): SessionView[] {
  if (incoming.length === 0) return existing;
  const byId = new Map(incoming.map((session) => [session.id, session]));
  return sortSessions(
    existing.map((session) => {
      const next = byId.get(session.id);
      return next ? fresherSession(session, next) : session;
    }),
  );
}

function onboardStorageKey(userId: string): string {
  return `${ONBOARD_STORAGE_PREFIX}${userId}`;
}

function readOnboarded(userId: string): boolean {
  try {
    return window.localStorage.getItem(onboardStorageKey(userId)) === "true";
  } catch {
    return false;
  }
}

function markOnboarded(userId: string) {
  try {
    window.localStorage.setItem(onboardStorageKey(userId), "true");
  } catch {
    // Ignore storage failures; the prompt is non-critical.
  }
}

export function SessionsPage({
  token,
  initialMe,
  theme,
  onSetTheme,
  onSignOut,
}: SessionsPageProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sessionMatch = useMatch("/sessions/:sessionId");
  const workspaceMatch = useMatch("/devices/:deviceId/workspaces");
  const deviceMatch = useMatch("/devices/:deviceId");
  const teamMatch = useMatch("/team");
  const serviceMatch = useMatch("/service");
  const settingsMatch = useMatch("/settings");
  const routeSessionId = sessionMatch?.params.sessionId ?? null;
  const routeDeviceId =
    workspaceMatch?.params.deviceId ?? deviceMatch?.params.deviceId ?? null;

  const [me, setMe] = useState<AuthMe>(initialMe);

  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [pairing, setPairing] = useState<PairingState>(false);
  const [onboardPromptOpen, setOnboardPromptOpen] = useState(false);
  const [initialOptimisticItems, setInitialOptimisticItems] = useState<
    Record<string, TimelineItem[]>
  >({});

  const [collapsed, setCollapsed] = useState(false);
  const [flyout, setFlyout] = useState(false);
  const [openSections, setOpenSections] = useState({
    devices: true,
    pinned: true,
    recents: true,
  });
  const [filters, setFilters] = useState<FilterState>(FILTER_DEFAULTS);
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  const [rowMenu, setRowMenu] = useState<
    { id: string; anchor: HTMLElement } | null
  >(null);
  const [renaming, setRenaming] = useState<
    { id: string; title: string } | null
  >(null);

  const flyoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filterCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onboardPromptCheckedRef = useRef(false);

  // Refresh /auth/me when the page mounts so a returning session picks up any
  // role / avatar changes made elsewhere (admin edited us from Team, etc.).
  useEffect(() => {
    let cancelled = false;
    api
      .me(token)
      .then((fresh) => {
        if (!cancelled) setMe(fresh);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onSignOut();
      });
    return () => {
      cancelled = true;
    };
  }, [token, onSignOut]);

  const refreshConnectors = useCallback(async () => {
    try {
      const res = await api.listConnectors(token);
      setConnectors(res.connectors);
      if (res.connectors.length > 0) {
        markOnboarded(me.userId);
      } else if (!onboardPromptCheckedRef.current) {
        onboardPromptCheckedRef.current = true;
        if (!readOnboarded(me.userId)) setOnboardPromptOpen(true);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignOut();
    }
  }, [token, me.userId, onSignOut]);

  const refreshSessions = useCallback(async () => {
    try {
      const res = await api.listSessions(token);
      setSessions((prev) => mergeSessionList(prev, res.sessions));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignOut();
    } finally {
      setSessionsLoading(false);
    }
  }, [token, onSignOut]);

  const refreshDashboard = useCallback(async () => {
    await Promise.all([refreshConnectors(), refreshSessions()]);
  }, [refreshConnectors, refreshSessions]);

  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let closed = false;
    let eventSource: EventSource | null = null;
    let syncing = false;
    let pending = false;

    const runRefresh = () => {
      if (closed) return;
      if (syncing) {
        pending = true;
        return;
      }
      syncing = true;
      refreshDashboard().finally(() => {
        syncing = false;
        if (closed) return;
        if (pending) {
          pending = false;
          runRefresh();
        }
      });
    };

    const scheduleRefresh = (delay = 0) => {
      if (closed) return;
      if (delay === 0 && syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      } else if (syncTimerRef.current) {
        return;
      }
      syncTimerRef.current = setTimeout(() => {
        syncTimerRef.current = null;
        runRefresh();
      }, delay);
    };

    runRefresh();

    try {
      eventSource = new EventSource(api.dashboardEventsUrl(token));
      eventSource.onmessage = (event) => {
        try {
          JSON.parse(event.data) as DashboardEvent;
        } catch {
          return;
        }
        scheduleRefresh(0);
      };
      eventSource.onerror = () => {
        if (eventSource?.readyState !== EventSource.OPEN) {
          scheduleRefresh(DASHBOARD_RETRY_SYNC_MS);
        }
      };
    } catch {
      scheduleRefresh(DASHBOARD_RETRY_SYNC_MS);
    }

    return () => {
      closed = true;
      eventSource?.close();
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    };
  }, [token, refreshDashboard]);

  const hasFilters = useMemo(
    () =>
      (Object.keys(FILTER_DEFAULTS) as FilterKey[]).some(
        (k) => filters[k] !== FILTER_DEFAULTS[k],
      ),
    [filters],
  );

  // Filter options mostly come from loaded sessions, but agent choices should
  // also reflect explicitly attached device agents. A newly paired device can
  // know about Claude before its historical sessions have finished syncing.
  const filterOptions = useMemo<Record<FilterKey, FilterOption[]>>(() => {
    const connectorNames = new Map(connectors.map((c) => [c.id, c.name]));
    const devices = new Map<string, string>();
    const agents = new Map<string, string>();
    const workspaces = new Map<string, string>();
    for (const c of connectors) {
      for (const runtime of Object.keys(c.runtimeCapabilities.attached)) {
        if (!agents.has(runtime)) agents.set(runtime, runtimeLabel(runtime));
      }
    }
    for (const s of sessions) {
      if (!devices.has(s.connectorId)) {
        devices.set(
          s.connectorId,
          connectorNames.get(s.connectorId) ?? shortConnectorLabel(s.connectorId),
        );
      }
      if (!agents.has(s.runtime)) {
        agents.set(s.runtime, runtimeLabel(s.runtime));
      }
      const ws = workspaceKey(s.cwd);
      if (!workspaces.has(ws)) workspaces.set(ws, ws);
    }
    return {
      device: [
        { value: "all", label: "All devices" },
        ...Array.from(devices, ([value, label]) => ({ value, label })),
      ],
      agent: [
        { value: "all", label: "All agents" },
        ...Array.from(agents, ([value, label]) => ({ value, label })),
      ],
      status: [
        { value: "active", label: "Active" },
        { value: "archived", label: "Archived" },
        { value: "all", label: "All" },
      ],
      workspace: [
        { value: "all", label: "All workspaces" },
        ...Array.from(workspaces, ([value, label]) => ({ value, label })),
      ],
    };
  }, [sessions, connectors]);

  // Strict design rule: only allow the flyout when the user could conceivably
  // start a new session. We now have real connector data, so use it.
  const canStartSession = connectors.some(
    (c) =>
      c.status === "online" &&
      Object.keys(c.runtimeCapabilities.attached).length > 0,
  );

  const showFlyout = () => {
    if (!canStartSession && sessions.length === 0) return;
    if (flyoutTimer.current) clearTimeout(flyoutTimer.current);
    setFlyout(true);
  };
  const hideFlyout = () => {
    if (flyoutTimer.current) clearTimeout(flyoutTimer.current);
    flyoutTimer.current = setTimeout(
      () => setFlyout(false),
      HOVER_CLOSE_DELAY_MS,
    );
  };

  const showFilter = (el: HTMLElement) => {
    if (filterCloseTimer.current) clearTimeout(filterCloseTimer.current);
    setFilterAnchor(el);
  };
  const hideFilterSoon = () => {
    if (filterCloseTimer.current) clearTimeout(filterCloseTimer.current);
    filterCloseTimer.current = setTimeout(
      () => setFilterAnchor(null),
      HOVER_CLOSE_DELAY_MS,
    );
  };

  const toggleSection = (k: "devices" | "pinned" | "recents") =>
    setOpenSections((s) => ({ ...s, [k]: !s[k] }));

  const handleAvatarChange = (avatar: string | null) =>
    setMe((prev) => ({ ...prev, avatar }));

  const handleSessionRefreshed = useCallback((next: SessionView) => {
    setSessions((list) => mergeSessionPatches(list, [next]));
  }, []);

  const handleSessionsBulkPatched = useCallback((updated: SessionView[]) => {
    setSessions((list) => mergeSessionPatches(list, updated));
  }, []);

  const applySessionPatch = (
    id: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean },
  ) => {
    api.patchSession(token, id, patch).then(
      (res) => {
        setSessions((list) => mergeSessionPatches(list, [res.session]));
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onSignOut();
        // Other errors are silent — the local list just stays in sync with
        // whatever the next poll returns.
      },
    );
  };

  const togglePin = (id: string) => {
    const target = sessions.find((s) => s.id === id);
    if (!target) return;
    applySessionPatch(id, { pinned: !target.pinned });
  };
  const toggleArchive = (id: string) => {
    const target = sessions.find((s) => s.id === id);
    if (!target) return;
    applySessionPatch(id, { archived: !target.archived });
  };
  const renameSession = (id: string, title: string) =>
    applySessionPatch(id, { title });

  const markRead = useCallback(
    (id: string) => {
      // Optimistic: flip the local dot immediately so opening feels instant.
      // The /read response and dashboard SSE reconcile with the server. Any
      // new activity that bumped updated_seq while the POST was in flight will
      // correctly re-arm `unread`.
      setSessions((list) =>
        list.map((s) =>
          s.id === id && s.unread
            ? { ...s, unread: false, lastReadSeq: s.updatedSeq }
            : s,
        ),
      );
      api.markSessionRead(token, id).then(
        (res) => {
          setSessions((list) => mergeSessionPatches(list, [res.session]));
        },
        (err: unknown) => {
          if (err instanceof ApiError && err.status === 401) onSignOut();
          // Other failures are silent — the next poll will reconcile.
        },
      );
    },
    [token, onSignOut],
  );

  const markVisibleRead = useCallback(
    (ids: string[]) => {
      const uniqueIds = Array.from(new Set(ids));
      if (uniqueIds.length === 0) return;
      const target = new Set(uniqueIds);
      setSessions((list) =>
        list.map((s) =>
          target.has(s.id) && s.unread
            ? { ...s, unread: false, lastReadSeq: s.updatedSeq }
            : s,
        ),
      );
      api.bulkReadSessions(token, uniqueIds).then(
        (res) => {
          handleSessionsBulkPatched(res.sessions);
        },
        (err: unknown) => {
          if (err instanceof ApiError && err.status === 401) onSignOut();
        },
      );
    },
    [token, onSignOut, handleSessionsBulkPatched],
  );

  // Opening a session = marking it read. Driving this from the route (instead
  // of onPickSession) also covers the initial auto-select after first load.
  useEffect(() => {
    if (routeSessionId) markRead(routeSessionId);
  }, [routeSessionId, markRead]);

  const handlePaired = (connector: ConnectorView) => {
    markOnboarded(me.userId);
    setPairing(false);
    refreshConnectors();
    navigate(`/devices/${encodeURIComponent(connector.id)}`);
  };

  const dismissOnboardPrompt = () => {
    markOnboarded(me.userId);
    setOnboardPromptOpen(false);
  };

  const startOnboardPairing = () => {
    markOnboarded(me.userId);
    setOnboardPromptOpen(false);
    setPairing({});
  };

  const handleSessionCreated = (
    session: SessionView,
    initialOptimisticItem?: TimelineItem,
  ) => {
    setSessions((prev) => [session, ...prev.filter((s) => s.id !== session.id)]);
    if (initialOptimisticItem) {
      setInitialOptimisticItems((prev) => ({
        ...prev,
        [session.id]: [initialOptimisticItem],
      }));
    }
    navigate(`/sessions/${encodeURIComponent(session.id)}`);
  };

  const clearInitialOptimisticItems = useCallback((sessionId: string) => {
    setInitialOptimisticItems((prev) => {
      if (!prev[sessionId]) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  const handleDeviceRenamed = (next: ConnectorView) => {
    setConnectors((prev) => prev.map((c) => (c.id === next.id ? next : c)));
  };

  const handleDeviceDeleted = () => {
    if (!routeDeviceId) return;
    const deletedId = routeDeviceId;
    navigate("/");
    setConnectors((prev) => prev.filter((c) => c.id !== deletedId));
    refreshConnectors();
  };

  // After Refresh / Add / Remove on the Agents panel: patch the local connector
  // in place so the device card re-renders immediately. We avoid a full list
  // refetch because the API already returned the latest capabilities.
  // `deletedRuntime` lets the caller signal a runtime removal so we also
  // evict its sessions from the sidebar in the same tick — the server has
  // already cascade-deleted them, but a refetch would race.
  const handleCapabilitiesChanged = (
    connectorId: string,
    caps: import("../../lib/api").DeviceAgentsState,
    deletedRuntime?: string,
  ) => {
    setConnectors((prev) =>
      prev.map((c) =>
        c.id === connectorId ? { ...c, runtimeCapabilities: caps } : c,
      ),
    );
    if (deletedRuntime) {
      setSessions((prev) =>
        prev.filter(
          (s) => !(s.connectorId === connectorId && s.runtime === deletedRuntime),
        ),
      );
    }
  };

  // Show every connector the server knows about, including offline connectors
  // that have never connected. Users need a visible row so they can delete or
  // revoke a device created by an interrupted pairing flow.
  // Stable order: sort by pairing time (createdAt), then id as a tiebreaker, so
  // the Devices list doesn't reshuffle on every poll just because the backend
  // returned the connectors in a different order.
  const visibleConnectors = connectors
    .sort((a, b) => {
      const at = a.createdAt || "";
      const bt = b.createdAt || "";
      if (at !== bt) return at < bt ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const activeDevice =
    routeDeviceId != null
      ? visibleConnectors.find((c) => c.id === routeDeviceId) ?? null
      : null;
  const activeSession =
    routeSessionId != null ? sessions.find((s) => s.id === routeSessionId) ?? null : null;

  const collapsedZone = collapsed ? (
    <div
      className="kl-collapsed-zone"
      onMouseEnter={showFlyout}
      onMouseLeave={hideFlyout}
    >
      <button
        type="button"
        className="kl-iconbtn"
        title="Expand sidebar"
        onClick={() => {
          setCollapsed(false);
          setFlyout(false);
        }}
      >
        <Icons.Sidebar size={15} />
      </button>
    </div>
  ) : null;

  const sidebarProps = {
    me,
    theme,
    onLogout: onSignOut,
    onOpenSettings: () => navigate("/settings"),
    onOpenTeam: () => navigate("/team"),
    onOpenService: () => navigate("/service"),
    connectors: visibleConnectors,
    activeDeviceId: routeDeviceId,
    onPickDevice: (id: string) => {
      navigate(`/devices/${encodeURIComponent(id)}`);
      setFlyout(false);
    },
    onNewDevice: () => {
      setPairing({});
      setFlyout(false);
    },
    canStartSession,
    onNewSession: () => {
      navigate("/new");
      setFlyout(false);
    },
    sessions,
    sessionsLoading,
    activeId: routeSessionId,
    onPickSession: (id: string) => {
      navigate(`/sessions/${encodeURIComponent(id)}`);
      setFlyout(false);
      // Also call here (in addition to the route effect) so re-picking the
      // same session after new activity still clears its dot.
      markRead(id);
    },
    onToggleCollapse: () => setCollapsed(true),
    openSections,
    toggleSection,
    filters,
    hasFilters,
    onShowFilter: showFilter,
    onHideFilter: hideFilterSoon,
    onMarkVisibleRead: markVisibleRead,
    rowMenuId: rowMenu?.id ?? null,
    onOpenRowMenu: (id: string, anchor: HTMLElement) =>
      setRowMenu({ id, anchor }),
  };

  return (
    <>
      <div className={`kl-app${collapsed ? " no-sb" : ""}`}>
        {!collapsed && <Sidebar {...sidebarProps} />}
        <div className="kl-main">
          {collapsedZone}
          {activeDevice && workspaceMatch ? (
            <WorkspacePage
              token={token}
              device={activeDevice}
              sessions={sessions}
              initialWorkspaceCwd={searchParams.get("cwd")}
              onBack={() =>
                navigate(`/devices/${encodeURIComponent(activeDevice.id)}`)
              }
              onNewSession={(cwd) => {
                navigate(
                  `/new?connectorId=${encodeURIComponent(activeDevice.id)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""}`,
                );
              }}
            />
          ) : activeDevice ? (
            <DevicePage
              token={token}
              device={activeDevice}
              sessions={sessions}
              onRename={handleDeviceRenamed}
              onDeleted={handleDeviceDeleted}
              onTokenRotated={(credential) => {
                setPairing({
                  credential,
                  title: `Reconnect ${credential.connector.name}`,
                });
                refreshConnectors();
              }}
              onPickSession={(id: string) => {
                navigate(`/sessions/${encodeURIComponent(id)}`);
              }}
              onPickWorkspace={(cwd) => {
                const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
                navigate(
                  `/devices/${encodeURIComponent(activeDevice.id)}/workspaces${query}`,
                );
              }}
              onNewSession={(cwd) => {
                navigate(
                  `/new?connectorId=${encodeURIComponent(activeDevice.id)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""}`,
                );
              }}
              onShowAllWorkspaces={() =>
                navigate(
                  `/devices/${encodeURIComponent(activeDevice.id)}/workspaces`,
                )
              }
              onCapabilitiesChanged={handleCapabilitiesChanged}
              onSessionsPatched={handleSessionsBulkPatched}
            />
          ) : activeSession ? (
            <SessionDetailView
              token={token}
              session={activeSession}
              connector={
                visibleConnectors.find(
                  (c) => c.id === activeSession.connectorId,
                ) ?? null
              }
              onSessionRefreshed={handleSessionRefreshed}
              onUnauthorized={onSignOut}
              initialOptimisticItems={initialOptimisticItems[activeSession.id]}
              onInitialOptimisticItemsSettled={clearInitialOptimisticItems}
              sidebarCollapsed={collapsed}
            />
          ) : (
            <NewSessionPage
              token={token}
              connectors={visibleConnectors}
              sessions={sessions}
              preferredConnectorId={searchParams.get("connectorId") ?? routeDeviceId}
              initialCwd={searchParams.get("cwd")}
              onNewDevice={() => setPairing({})}
              onCreated={handleSessionCreated}
            />
          )}
        </div>
      </div>

      {collapsed && flyout && (
        <div
          className="kl-sb-flyout-wrap"
          onMouseEnter={showFlyout}
          onMouseLeave={hideFlyout}
        >
          <Sidebar {...sidebarProps} mini />
        </div>
      )}

      {filterAnchor && (
        <FilterMenu
          anchor={filterAnchor}
          filters={filters}
          options={filterOptions}
          onChange={(k, v) => setFilters((f) => ({ ...f, [k]: v }))}
          onReset={() => setFilters(FILTER_DEFAULTS)}
          onClose={() => setFilterAnchor(null)}
          onMouseEnter={() => showFilter(filterAnchor)}
          onMouseLeave={hideFilterSoon}
        />
      )}

      {rowMenu && (
        <SessionRowMenu
          anchor={rowMenu.anchor}
          isPinned={!!sessions.find((s) => s.id === rowMenu.id)?.pinned}
          isArchived={!!sessions.find((s) => s.id === rowMenu.id)?.archived}
          onPin={() => togglePin(rowMenu.id)}
          onArchive={() => toggleArchive(rowMenu.id)}
          onRename={() => {
            const s = sessions.find((x) => x.id === rowMenu.id);
            setRenaming({ id: rowMenu.id, title: s?.title || "" });
          }}
          onClose={() => setRowMenu(null)}
        />
      )}

      {renaming && (
        <RenameSessionModal
          initial={renaming.title}
          onCancel={() => setRenaming(null)}
          onSave={(title) => {
            renameSession(renaming.id, title);
            setRenaming(null);
          }}
        />
      )}

      {settingsMatch && (
        <SettingsPage
          me={me}
          token={token}
          theme={theme}
          onSetTheme={onSetTheme}
          onAvatarChange={handleAvatarChange}
          onBack={() => navigate("/")}
        />
      )}

      {teamMatch && (
        <TeamPage me={me} token={token} onBack={() => navigate("/")} />
      )}

      {serviceMatch && (
        <ServicePage token={token} onBack={() => navigate("/")} />
      )}

      {pairing && (
        <PairDeviceModal
          token={token}
          initialCredential={pairing.credential ?? null}
          title={pairing.title}
          onCancel={() => {
            setPairing(false);
            refreshConnectors();
          }}
          onPaired={handlePaired}
        />
      )}

      {onboardPromptOpen && !pairing && (
        <ConfirmModal
          title="Add your first device?"
          body="You don't have a device yet. Add one to connect this browser to a machine running your agents."
          confirmLabel="Add device"
          onCancel={dismissOnboardPrompt}
          onConfirm={startOnboardPairing}
        />
      )}

    </>
  );
}

function shortConnectorLabel(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 10)}…`;
}
