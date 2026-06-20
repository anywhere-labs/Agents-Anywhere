"use client";

import * as React from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Filter,
  Folder,
  Hand,
  Laptop,
  LogOut,
  MoreHorizontal,
  PanelLeft,
  Paperclip,
  Plus,
  Search,
  Send,
  Settings,
  Users
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  ActionMenu,
  AppDialog,
  ConfirmDialog,
  Identicon,
  LoadingState
} from "@/components/common";
import { BrandWord, type ThemeMode } from "@/components/layout";
import { IconButton } from "@/components/common/icon-button";
import { errorMessage } from "@/lib/api";
import {
  authApi,
  clearStoredSession,
  loadStoredSession,
  type AuthMe,
  type StoredSession
} from "@/features/auth";
import {
  dashboardApi,
  type ConnectorView,
  type SessionView
} from "@/features/dashboard";
import { cn } from "@/lib/utils";

type DashboardAuthState =
  | { kind: "checking" }
  | { kind: "auth" }
  | { kind: "ready"; session: StoredSession; me: AuthMe };

type DashboardRoute =
  | { kind: "new" }
  | { kind: "session"; id: string }
  | { kind: "device"; id: string; workspace?: boolean }
  | { kind: "team" }
  | { kind: "service" }
  | { kind: "settings" };

type OpenSections = {
  devices: boolean;
  pinned: boolean;
  recents: boolean;
};

type FilterState = {
  status: "active" | "archived" | "all";
};

const DASHBOARD_RETRY_SYNC_MS = 10000;
const HOVER_CLOSE_DELAY_MS = 180;
const NEW_SESSION_TITLES = [
  "What should we build next?",
  "Where should the agent start?",
  "What should we work on?",
  "Give the agent a task.",
  "Start from a workspace.",
  "What needs attention?",
  "Send work to the right device."
] as const;

export function DashboardClient() {
  const t = useTranslations("dashboard");
  const common = useTranslations("common");
  const [theme] = React.useState<ThemeMode>("dark");
  const [authState, setAuthState] = React.useState<DashboardAuthState>(() => {
    const session = loadStoredSession();
    return session ? { kind: "checking" } : { kind: "auth" };
  });
  const [me, setMe] = React.useState<AuthMe | null>(null);
  const [connectors, setConnectors] = React.useState<ConnectorView[]>([]);
  const [sessions, setSessions] = React.useState<SessionView[]>([]);
  const [sessionsLoading, setSessionsLoading] = React.useState(true);
  const [route, setRoute] = React.useState<DashboardRoute>(() => readRoute());
  const [collapsed, setCollapsed] = React.useState(false);
  const [flyout, setFlyout] = React.useState(false);
  const [openSections, setOpenSections] = React.useState<OpenSections>({
    devices: true,
    pinned: true,
    recents: true
  });
  const [filters, setFilters] = React.useState<FilterState>({ status: "active" });
  const [signOutOpen, setSignOutOpen] = React.useState(false);
  const [pairDialogOpen, setPairDialogOpen] = React.useState(false);
  const [dashboardError, setDashboardError] = React.useState<string | null>(null);
  const flyoutTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const session = authState.kind === "ready" ? authState.session : null;

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  React.useEffect(() => {
    const onHashChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  React.useEffect(() => {
    if (authState.kind !== "checking") return;
    const stored = loadStoredSession();
    if (!stored) {
      setAuthState({ kind: "auth" });
      return;
    }

    let cancelled = false;
    authApi
      .me(stored.accessToken)
      .then((nextMe) => {
        if (cancelled) return;
        setMe(nextMe);
        setAuthState({ kind: "ready", session: stored, me: nextMe });
      })
      .catch(() => {
        if (cancelled) return;
        clearStoredSession();
        setAuthState({ kind: "auth" });
      });

    return () => {
      cancelled = true;
    };
  }, [authState.kind]);

  React.useEffect(() => {
    if (authState.kind !== "auth") return;
    window.location.replace(`/${document.documentElement.lang || "en"}/login`);
  }, [authState.kind]);

  React.useEffect(() => {
    if (!session) return;
    let cancelled = false;
    authApi
      .me(session.accessToken)
      .then((fresh) => {
        if (!cancelled) setMe(fresh);
      })
      .catch(() => {
        if (!cancelled) signOut();
      });
    return () => {
      cancelled = true;
    };
  }, [session?.accessToken]);

  const refreshDashboard = React.useCallback(async () => {
    if (!session) return;
    setDashboardError(null);
    try {
      const [connectorResult, sessionResult] = await Promise.all([
        dashboardApi.listConnectors(session.accessToken),
        dashboardApi.listSessions(session.accessToken)
      ]);
      setConnectors(sortConnectors(connectorResult.connectors));
      setSessions(sortSessions(sessionResult.sessions));
    } catch (err) {
      setDashboardError(errorMessage(err, t("errors.loadFailed")));
    } finally {
      setSessionsLoading(false);
    }
  }, [session, t]);

  React.useEffect(() => {
    void refreshDashboard();
  }, [refreshDashboard]);

  React.useEffect(() => {
    if (!session) return;
    let closed = false;
    let eventSource: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefresh = (delay = 0) => {
      if (closed) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void refreshDashboard();
      }, delay);
    };

    try {
      eventSource = new EventSource(dashboardApi.dashboardEventsUrl(session.accessToken));
      eventSource.onmessage = () => scheduleRefresh(0);
      eventSource.onerror = () => scheduleRefresh(DASHBOARD_RETRY_SYNC_MS);
    } catch {
      scheduleRefresh(DASHBOARD_RETRY_SYNC_MS);
    }

    return () => {
      closed = true;
      eventSource?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [session, refreshDashboard]);

  if (authState.kind === "checking") {
    return (
      <main className="aa-dash-boot">
        <LoadingState label={t("status.restoring")} />
      </main>
    );
  }

  if (authState.kind === "auth" || !session || !me) {
    return null;
  }

  const visibleConnectors = sortConnectors(connectors);
  const visibleSessions = sessions.filter((item) => {
    if (filters.status === "active") return !item.archived;
    if (filters.status === "archived") return item.archived;
    return true;
  });
  const activeSession = route.kind === "session"
    ? sessions.find((item) => item.id === route.id) ?? null
    : null;
  const activeDevice = route.kind === "device"
    ? visibleConnectors.find((item) => item.id === route.id) ?? null
    : null;
  const canStartSession = visibleConnectors.some(
    (connector) =>
      connector.status === "online" &&
      Object.keys(connector.runtimeCapabilities.attached).length > 0,
  );

  const navigate = (nextRoute: DashboardRoute) => {
    writeRoute(nextRoute);
    setRoute(nextRoute);
    setFlyout(false);
  };

  const showFlyout = () => {
    if (!canStartSession && sessions.length === 0) return;
    if (flyoutTimer.current) clearTimeout(flyoutTimer.current);
    setFlyout(true);
  };
  const hideFlyout = () => {
    if (flyoutTimer.current) clearTimeout(flyoutTimer.current);
    flyoutTimer.current = setTimeout(() => setFlyout(false), HOVER_CLOSE_DELAY_MS);
  };

  const signOut = () => {
    clearStoredSession();
    setSignOutOpen(false);
    window.location.replace(`/${document.documentElement.lang || "en"}/login`);
  };

  const toggleSection = (key: keyof OpenSections) => {
    setOpenSections((current) => ({ ...current, [key]: !current[key] }));
  };

  const patchSession = (id: string, patch: { pinned?: boolean; archived?: boolean }) => {
    setSessions((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
    dashboardApi.patchSession(session.accessToken, id, patch).then(
      (result) => {
        setSessions((current) => mergeSessionPatches(current, [result.session]));
      },
      () => void refreshDashboard(),
    );
  };

  const markRead = (id: string) => {
    setSessions((current) =>
      current.map((item) =>
        item.id === id && item.unread
          ? { ...item, unread: false, lastReadSeq: item.updatedSeq }
          : item,
      ),
    );
    dashboardApi.markSessionRead(session.accessToken, id).then(
      (result) => setSessions((current) => mergeSessionPatches(current, [result.session])),
      () => void refreshDashboard(),
    );
  };

  const createSession = async (body: {
    connectorId: string;
    runtime: string;
    title?: string;
    cwd?: string;
    approvalPolicy?: string;
    sandbox?: string;
  }) => {
    const created = await dashboardApi.createSession(session.accessToken, body);
    setSessions((current) => sortSessions([created.session, ...current.filter((item) => item.id !== created.session.id)]));
    navigate({ kind: "session", id: created.session.id });
  };

  const sidebar = (
    <DashboardSidebar
      me={me}
      connectors={visibleConnectors}
      sessions={visibleSessions}
      sessionsLoading={sessionsLoading}
      activeRoute={route}
      canStartSession={canStartSession}
      openSections={openSections}
      filters={filters}
      onSetFilters={setFilters}
      onToggleSection={toggleSection}
      onToggleCollapse={() => setCollapsed(true)}
      onNewSession={() => navigate({ kind: "new" })}
      onNewDevice={() => setPairDialogOpen(true)}
      onPickDevice={(id) => navigate({ kind: "device", id })}
      onPickSession={(id) => {
        markRead(id);
        navigate({ kind: "session", id });
      }}
      onPatchSession={patchSession}
      onOpenSettings={() => navigate({ kind: "settings" })}
      onOpenTeam={() => navigate({ kind: "team" })}
      onOpenService={() => navigate({ kind: "service" })}
      onSignOut={() => setSignOutOpen(true)}
    />
  );

  return (
    <>
      <div className={cn("aa-dash-app", collapsed && "no-sb")}>
        {!collapsed ? sidebar : null}
        <div className="aa-dash-main">
          {collapsed ? (
            <div
              className="aa-dash-collapsed-zone"
              onMouseEnter={showFlyout}
              onMouseLeave={hideFlyout}
            >
              <IconButton
                label={t("actions.expand")}
                size="sm"
                onClick={() => {
                  setCollapsed(false);
                  setFlyout(false);
                }}
              >
                <PanelLeft aria-hidden="true" />
              </IconButton>
            </div>
          ) : null}
          <DashboardMain
            route={route}
            connectors={visibleConnectors}
            sessions={sessions}
            activeSession={activeSession}
            activeDevice={activeDevice}
            loading={sessionsLoading}
            error={dashboardError}
            onNewDevice={() => setPairDialogOpen(true)}
            onCreateSession={createSession}
            onNavigate={navigate}
          />
        </div>
      </div>

      {collapsed && flyout ? (
        <div
          className="aa-dash-sb-flyout"
          onMouseEnter={showFlyout}
          onMouseLeave={hideFlyout}
        >
          {sidebar}
        </div>
      ) : null}

      <ConfirmDialog
        open={signOutOpen}
        onOpenChange={setSignOutOpen}
        title={t("signOut.title")}
        description={t("signOut.description")}
        confirmLabel={t("signOut.confirm")}
        cancelLabel={common("cancel")}
        onConfirm={signOut}
      />

      <AppDialog
        open={pairDialogOpen}
        onOpenChange={setPairDialogOpen}
        title={t("pair.title")}
        description={t("pair.description")}
        size="sm"
        footer={
          <Button type="button" variant="emphasis" onClick={() => setPairDialogOpen(false)}>
            {common("continue")}
          </Button>
        }
      />
    </>
  );
}

type DashboardSidebarProps = {
  me: AuthMe;
  connectors: ConnectorView[];
  sessions: SessionView[];
  sessionsLoading: boolean;
  activeRoute: DashboardRoute;
  canStartSession: boolean;
  openSections: OpenSections;
  filters: FilterState;
  onSetFilters: (filters: FilterState) => void;
  onToggleSection: (key: keyof OpenSections) => void;
  onToggleCollapse: () => void;
  onNewSession: () => void;
  onNewDevice: () => void;
  onPickDevice: (id: string) => void;
  onPickSession: (id: string) => void;
  onPatchSession: (id: string, patch: { pinned?: boolean; archived?: boolean }) => void;
  onOpenSettings: () => void;
  onOpenTeam: () => void;
  onOpenService: () => void;
  onSignOut: () => void;
};

function DashboardSidebar({
  me,
  connectors,
  sessions,
  sessionsLoading,
  activeRoute,
  canStartSession,
  openSections,
  filters,
  onSetFilters,
  onToggleSection,
  onToggleCollapse,
  onNewSession,
  onNewDevice,
  onPickDevice,
  onPickSession,
  onPatchSession,
  onOpenSettings,
  onOpenTeam,
  onOpenService,
  onSignOut
}: DashboardSidebarProps) {
  const t = useTranslations("dashboard");
  const [userMenuOpen, setUserMenuOpen] = React.useState(false);
  const pinned = sessions.filter((item) => item.pinned);
  const recents = sessions.filter((item) => !item.pinned);
  const noSessionsAtAll = sessions.length === 0;

  return (
    <aside className="aa-dash-sb">
      <div className="aa-dash-sb-hd">
        <div className="brand">
          <BrandWord className="text-[length:20px]" />
        </div>
        <div className="acts">
          <IconButton label={t("actions.search")} size="sm" disabled className="opacity-40">
            <Search aria-hidden="true" />
          </IconButton>
          <IconButton label={t("actions.collapse")} size="sm" onClick={onToggleCollapse}>
            <PanelLeft aria-hidden="true" />
          </IconButton>
        </div>
      </div>

      <button
        type="button"
        className="aa-dash-sb-new"
        title={canStartSession ? t("actions.newSession") : t("empty.noOnlineDevice")}
        onClick={onNewSession}
      >
        <Plus aria-hidden="true" />
        <span>{t("actions.newSession")}</span>
        <span className="shortcut">⌘N</span>
      </button>

      <div className="aa-dash-sb-scroll">
        <SidebarSection
          label={t("sections.devices")}
          open={openSections.devices}
          onToggle={() => onToggleSection("devices")}
          action={
            <button type="button" className="act" title={t("actions.pairDevice")} onClick={(event) => {
              event.stopPropagation();
              onNewDevice();
            }}>
              <Plus aria-hidden="true" />
            </button>
          }
        >
          {connectors.length === 0 ? (
            <button type="button" className="aa-dash-sb-empty clickable" onClick={onNewDevice}>
              {t.rich("empty.pairDevice", {
                here: (chunks) => <span className="here">{chunks}</span>
              })}
            </button>
          ) : (
            connectors.map((connector) => (
              <button
                type="button"
                key={connector.id}
                className={cn(
                  "aa-dash-dev",
                  connector.status,
                  activeRoute.kind === "device" && activeRoute.id === connector.id && "active",
                )}
                onClick={() => onPickDevice(connector.id)}
              >
                <span className="status" />
                <span className="name">{connector.name}</span>
              </button>
            ))
          )}
        </SidebarSection>

        {pinned.length > 0 ? (
          <SidebarSection
            label={t("sections.pinned")}
            open={openSections.pinned}
            onToggle={() => onToggleSection("pinned")}
          >
            <div className="aa-dash-sess-list">
              {pinned.map((item) => (
                <SessionRow
                  key={item.id}
                  session={item}
                  active={activeRoute.kind === "session" && activeRoute.id === item.id}
                  onPick={onPickSession}
                  onPatch={onPatchSession}
                />
              ))}
            </div>
          </SidebarSection>
        ) : null}

        <SidebarSection
          label={t("sections.recents")}
          open={openSections.recents}
          onToggle={() => onToggleSection("recents")}
          action={
            !noSessionsAtAll ? (
              <ActionMenu
                label={t("actions.filter")}
                items={[
                  {
                    id: "active",
                    label: t("filters.active"),
                    icon: filters.status === "active" ? <Check /> : undefined,
                    onSelect: () => onSetFilters({ status: "active" })
                  },
                  {
                    id: "archived",
                    label: t("filters.archived"),
                    icon: filters.status === "archived" ? <Check /> : undefined,
                    onSelect: () => onSetFilters({ status: "archived" })
                  },
                  {
                    id: "all",
                    label: t("filters.all"),
                    icon: filters.status === "all" ? <Check /> : undefined,
                    onSelect: () => onSetFilters({ status: "all" })
                  }
                ]}
              >
                <button
                  type="button"
                  className={cn("act", filters.status !== "active" && "has-filter")}
                  onClick={(event) => event.stopPropagation()}
                >
                  <Filter aria-hidden="true" />
                </button>
              </ActionMenu>
            ) : null
          }
        >
          {noSessionsAtAll && sessionsLoading ? (
            <SessionSkeletons />
          ) : noSessionsAtAll ? (
            <div className="aa-dash-sb-empty">{t("empty.noSessions")}</div>
          ) : recents.length === 0 ? (
            <div className="aa-dash-sb-empty mono">{t("empty.noSessionsMatch")}</div>
          ) : (
            <div className="aa-dash-sess-list">
              {recents.map((item) => (
                <SessionRow
                  key={item.id}
                  session={item}
                  active={activeRoute.kind === "session" && activeRoute.id === item.id}
                  onPick={onPickSession}
                  onPatch={onPatchSession}
                />
              ))}
            </div>
          )}
        </SidebarSection>
      </div>

      <div className="aa-dash-sb-foot">
        <button
          type="button"
          className="user-btn"
          onClick={() => setUserMenuOpen((open) => !open)}
          title={t("account.menu")}
        >
          {me.avatar ? (
            <img className="avatar-img" src={me.avatar} alt="" />
          ) : (
            <Identicon id={me.userId} size={30} />
          )}
          <span className="who">
            <span className="name">{me.userId}</span>
            <span className="role">{me.role === "admin" ? t("roles.admin") : t("roles.member")}</span>
          </span>
          <ChevronUp className="caret" aria-hidden="true" />
        </button>

        {userMenuOpen ? (
          <div className="aa-dash-user-menu">
            <div className="head">
              {me.avatar ? (
                <img className="avatar-img" src={me.avatar} alt="" />
              ) : (
                <Identicon id={me.userId} size={32} />
              )}
              <span className="who">
                <span className="id">{me.userId}</span>
                <span className="role">{me.role === "admin" ? t("roles.admin") : t("roles.member")}</span>
              </span>
            </div>
            <MenuButton icon={<Settings />} label={t("nav.settings")} onClick={onOpenSettings} />
            {me.role === "admin" ? (
              <>
                <MenuButton icon={<Users />} label={t("nav.team")} onClick={onOpenTeam} />
                <MenuButton icon={<Settings />} label={t("nav.service")} onClick={onOpenService} />
              </>
            ) : null}
            <div className="sep" />
            <MenuButton icon={<LogOut />} label={t("actions.signOut")} onClick={onSignOut} />
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function SidebarSection({
  label,
  open,
  action,
  children,
  onToggle
}: {
  label: React.ReactNode;
  open: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
  onToggle: () => void;
}) {
  return (
    <>
      <div className="aa-dash-sb-section" onClick={onToggle}>
        <span className={cn("chev", !open && "closed")}>
          <ChevronDown aria-hidden="true" />
        </span>
        <h4>{label}</h4>
        {action ? <div className="section-actions">{action}</div> : null}
      </div>
      {open ? children : null}
    </>
  );
}

function SessionRow({
  session,
  active,
  onPick,
  onPatch
}: {
  session: SessionView;
  active: boolean;
  onPick: (id: string) => void;
  onPatch: (id: string, patch: { pinned?: boolean; archived?: boolean }) => void;
}) {
  const t = useTranslations("dashboard");
  const waiting = session.status === "waiting_approval";
  const attention = waiting || session.unread;
  return (
    <div
      className={cn(
        "aa-dash-sess",
        active && "active",
        attention && "attention",
        waiting && "waiting",
        session.archived && "archived",
      )}
      onClick={() => onPick(session.id)}
    >
      <span className="dot" title={waiting ? t("sessionStatus.waiting_approval") : session.unread ? t("session.unread") : t("sessionStatus.idle")} />
      <span className="title">{session.title || t("session.untitled")}</span>
      <ActionMenu
        label={t("actions.sessionOptions")}
        items={[
          {
            id: "pin",
            label: session.pinned ? t("actions.unpin") : t("actions.pin"),
            onSelect: () => onPatch(session.id, { pinned: !session.pinned })
          },
          {
            id: "archive",
            label: session.archived ? t("actions.unarchive") : t("actions.archive"),
            destructive: !session.archived,
            onSelect: () => onPatch(session.id, { archived: !session.archived })
          }
        ]}
      >
        <button
          type="button"
          className="more"
          title={t("actions.sessionOptions")}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal aria-hidden="true" />
        </button>
      </ActionMenu>
    </div>
  );
}

function SessionSkeletons() {
  return (
    <div className="aa-dash-sess-list">
      {[0, 1, 2, 3, 4, 5].map((item) => (
        <div key={item} className="aa-dash-sess skeleton">
          <span className="skel dot-skel" />
          <span className="skel title-skel" style={{ width: `${55 + ((item * 11) % 30)}%` }} />
        </div>
      ))}
    </div>
  );
}

function MenuButton({
  icon,
  label,
  onClick
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" className="item" onClick={onClick}>
      <span className="[&_svg]:size-3.5">{icon}</span>
      {label}
    </button>
  );
}

function DashboardMain({
  route,
  connectors,
  sessions,
  activeSession,
  activeDevice,
  loading,
  error,
  onNewDevice,
  onCreateSession,
  onNavigate
}: {
  route: DashboardRoute;
  connectors: ConnectorView[];
  sessions: SessionView[];
  activeSession: SessionView | null;
  activeDevice: ConnectorView | null;
  loading: boolean;
  error: string | null;
  onNewDevice: () => void;
  onCreateSession: (body: {
    connectorId: string;
    runtime: string;
    title?: string;
    cwd?: string;
    approvalPolicy?: string;
    sandbox?: string;
  }) => Promise<void>;
  onNavigate: (route: DashboardRoute) => void;
}) {
  const t = useTranslations("dashboard");

  if (route.kind === "session" && activeSession) {
    return <SessionPlaceholder session={activeSession} />;
  }
  if (route.kind === "device" && activeDevice) {
    return <DevicePlaceholder device={activeDevice} sessions={sessions} onNewSession={() => onNavigate({ kind: "new" })} />;
  }
  if (route.kind === "team" || route.kind === "service" || route.kind === "settings") {
    return <SimplePage title={t(`nav.${route.kind}`)} description={t("placeholder.description")} />;
  }

  return (
    <NewSessionHome
      connectors={connectors}
      sessions={sessions}
      loading={loading}
      error={error}
      onNewDevice={onNewDevice}
      onCreateSession={onCreateSession}
    />
  );
}

function NewSessionHome({
  connectors,
  sessions,
  loading,
  error,
  onNewDevice,
  onCreateSession
}: {
  connectors: ConnectorView[];
  sessions: SessionView[];
  loading: boolean;
  error: string | null;
  onNewDevice: () => void;
  onCreateSession: (body: {
    connectorId: string;
    runtime: string;
    title?: string;
    cwd?: string;
    approvalPolicy?: string;
    sandbox?: string;
  }) => Promise<void>;
}) {
  const t = useTranslations("dashboard");
  const [titleIndex, setTitleIndex] = React.useState(0);
  const [typedTitle, setTypedTitle] = React.useState("");
  const [prompt, setPrompt] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const online = React.useMemo(
    () =>
      connectors.filter(
        (connector) =>
          connector.status === "online" &&
          Object.keys(connector.runtimeCapabilities.attached).length > 0,
      ),
    [connectors],
  );
  const [connectorId, setConnectorId] = React.useState("");
  const connector = online.find((item) => item.id === connectorId) ?? online[0] ?? null;
  const runtimes = connector ? attachedRuntimes(connector) : [];
  const [runtime, setRuntime] = React.useState("");
  const selectedRuntime = runtimes.includes(runtime) ? runtime : runtimes[0] ?? "";
  const canCreate = Boolean(connector && selectedRuntime && prompt.trim() && !creating);

  React.useEffect(() => {
    if (!connector && online[0]) setConnectorId(online[0].id);
  }, [connector, online]);

  React.useEffect(() => {
    if (!selectedRuntime && runtimes[0]) setRuntime(runtimes[0]);
  }, [runtimes, selectedRuntime]);

  React.useEffect(() => {
    if (creating) return;
    const title = NEW_SESSION_TITLES[titleIndex % NEW_SESSION_TITLES.length] ?? NEW_SESSION_TITLES[0];
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const write = (count: number) => {
      if (cancelled) return;
      setTypedTitle(title.slice(0, count));
      if (count < title.length) {
        timeout = setTimeout(() => write(count + 1), 58);
        return;
      }
      timeout = setTimeout(() => {
        if (!cancelled) setTitleIndex((index) => (index + 1) % NEW_SESSION_TITLES.length);
      }, 15000);
    };
    write(0);
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [creating, titleIndex]);

  const create = async () => {
    if (!canCreate || !connector) return;
    setCreating(true);
    try {
      await onCreateSession({
        connectorId: connector.id,
        runtime: selectedRuntime,
        title: prompt.trim(),
        cwd: defaultWorkspace(sessions, connector.id) ?? undefined
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="aa-new-page">
      <div className="aa-new-center">
        <h1 className="aa-new-title" aria-live="polite">
          <span>{creating ? t("new.creating") : typedTitle}</span>
          <span className="cursor" aria-hidden="true" />
        </h1>

        <div className="aa-comp aa-new-composer">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void create();
              }
            }}
            placeholder={t("new.placeholder")}
            rows={1}
          />
          <div className="aa-comp-row">
            <button type="button" className="aa-comp-sel" title={t("new.attach")} disabled>
              <Paperclip aria-hidden="true" />
            </button>
            <ActionMenu
              label={t("new.permissionMode")}
              items={[
                { id: "ask", label: t("new.askApproval"), icon: <Check /> },
                { id: "full", label: t("new.fullAccess") },
                { id: "read", label: t("new.readOnly") }
              ]}
            >
              <button type="button" className="aa-comp-sel">
                <Hand aria-hidden="true" />
                {t("new.askApproval")}
                <ChevronDown aria-hidden="true" />
              </button>
            </ActionMenu>
            <ActionMenu
              label={t("new.deviceAndAgent")}
              items={
                online.length === 0
                  ? [{ id: "none", label: t("empty.noOnlineDevice"), disabled: true }]
                  : online.flatMap((device) =>
                      attachedRuntimes(device).map((item) => ({
                        id: `${device.id}:${item}`,
                        label: `${device.name} / ${runtimeLabel(item)}`,
                        icon: device.id === connector?.id && item === selectedRuntime ? <Check /> : undefined,
                        onSelect: () => {
                          setConnectorId(device.id);
                          setRuntime(item);
                        }
                      })),
                    )
              }
            >
              <button type="button" className="aa-comp-sel">
                <Laptop aria-hidden="true" />
                {connector?.name || t("new.device")}
                {selectedRuntime ? (
                  <>
                    <span className="dotsep" />
                    <span className="agent-dot" aria-hidden="true" />
                    {runtimeLabel(selectedRuntime)}
                  </>
                ) : null}
                <ChevronDown aria-hidden="true" />
              </button>
            </ActionMenu>
            <span className="sep" />
            <button
              type="button"
              className="aa-send"
              disabled={!canCreate}
              title={t("new.createSession")}
              onClick={() => void create()}
            >
              {creating ? "…" : <Send aria-hidden="true" />}
            </button>
          </div>
        </div>

        <div className="aa-new-workspace">
          <button type="button" className="aa-new-workspace-trigger" disabled={!connector}>
            <Folder aria-hidden="true" />
            <span>{t("new.homeDirectory")}</span>
            <em>{defaultWorkspace(sessions, connector?.id ?? "") ?? t("new.defaultWorkspace")}</em>
            <ChevronDown aria-hidden="true" />
          </button>
        </div>

        {error ? <div className="aa-new-error">{error}</div> : null}
        {!connector && !loading ? (
          <div className="aa-new-empty">
            <span>{t("empty.noOnlineDevice")}</span>
            <Button type="button" variant="ghost" size="sm" onClick={onNewDevice}>
              <Plus aria-hidden="true" />
              {t("actions.pairDevice")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SessionPlaceholder({ session }: { session: SessionView }) {
  const t = useTranslations("dashboard");
  return (
    <div className="aa-detail-page">
      <header className="aa-detail-hd">
        <h1>{session.title || t("session.untitled")}</h1>
        <div className="chips">
          <span>{runtimeLabel(session.runtime)}</span>
          <span>{t(`sessionStatus.${session.status}`)}</span>
          {session.cwd ? <span>{workspaceKey(session.cwd)}</span> : null}
        </div>
      </header>
      <div className="aa-detail-empty">{t("placeholder.sessionDetail")}</div>
    </div>
  );
}

function DevicePlaceholder({
  device,
  sessions,
  onNewSession
}: {
  device: ConnectorView;
  sessions: SessionView[];
  onNewSession: () => void;
}) {
  const t = useTranslations("dashboard");
  const deviceSessions = sessions.filter((item) => item.connectorId === device.id);
  return (
    <div className="aa-detail-page">
      <header className="aa-detail-hd">
        <h1>{device.name}</h1>
        <div className="chips">
          <span>{device.status}</span>
          <span>{Object.keys(device.runtimeCapabilities.attached).map(runtimeLabel).join(", ") || t("session.none")}</span>
        </div>
      </header>
      <div className="aa-device-grid">
        <section>
          <h2>{t("sections.recents")}</h2>
          {deviceSessions.length === 0 ? (
            <p>{t("empty.noSessions")}</p>
          ) : (
            deviceSessions.slice(0, 8).map((item) => (
              <div key={item.id} className="aa-device-row">
                <span>{item.title || t("session.untitled")}</span>
                <em>{item.cwd ? workspaceKey(item.cwd) : t("session.none")}</em>
              </div>
            ))
          )}
        </section>
        <section>
          <h2>{t("session.workspace")}</h2>
          <Button type="button" variant="emphasis" onClick={onNewSession}>
            <Plus aria-hidden="true" />
            {t("actions.newSession")}
          </Button>
        </section>
      </div>
    </div>
  );
}

function SimplePage({
  title,
  description
}: {
  title: React.ReactNode;
  description: React.ReactNode;
}) {
  return (
    <div className="aa-detail-page">
      <header className="aa-detail-hd">
        <h1>{title}</h1>
      </header>
      <div className="aa-detail-empty">{description}</div>
    </div>
  );
}

function readRoute(): DashboardRoute {
  if (typeof window === "undefined") return { kind: "new" };
  const hash = window.location.hash.replace(/^#/, "") || "/";
  const path = hash.startsWith("/") ? hash : `/${hash}`;
  const parts = path.split("?")[0]!.split("/").filter(Boolean);
  if (parts[0] === "sessions" && parts[1]) return { kind: "session", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "devices" && parts[1]) {
    return { kind: "device", id: decodeURIComponent(parts[1]), workspace: parts[2] === "workspaces" };
  }
  if (parts[0] === "team") return { kind: "team" };
  if (parts[0] === "service") return { kind: "service" };
  if (parts[0] === "settings") return { kind: "settings" };
  return { kind: "new" };
}

function writeRoute(route: DashboardRoute) {
  const path =
    route.kind === "new"
      ? "/"
      : route.kind === "session"
        ? `/sessions/${encodeURIComponent(route.id)}`
        : route.kind === "device"
          ? `/devices/${encodeURIComponent(route.id)}${route.workspace ? "/workspaces" : ""}`
          : `/${route.kind}`;
  if (window.location.hash === `#${path}`) return;
  window.location.hash = path;
}

function sortConnectors(connectors: ConnectorView[]): ConnectorView[] {
  return [...connectors].sort((a, b) => {
    const at = a.createdAt || "";
    const bt = b.createdAt || "";
    if (at !== bt) return at < bt ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
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

function mergeSessionPatches(existing: SessionView[], incoming: SessionView[]): SessionView[] {
  const byId = new Map(incoming.map((item) => [item.id, item]));
  return sortSessions(existing.map((item) => byId.get(item.id) ?? item));
}

function attachedRuntimes(connector: ConnectorView): string[] {
  return Object.keys(connector.runtimeCapabilities.attached).sort();
}

function runtimeLabel(runtime: string): string {
  if (runtime === "codex") return "Codex";
  if (runtime === "claude") return "Claude";
  if (runtime === "opencode") return "OpenCode";
  if (runtime === "cursor") return "Cursor";
  return runtime.slice(0, 1).toUpperCase() + runtime.slice(1);
}

function workspaceKey(cwd: string | null): string {
  if (!cwd) return "(none)";
  const trimmed = cwd.replace(/\/+$/, "");
  const last = trimmed.split("/").filter(Boolean).pop();
  return last || "/";
}

function defaultWorkspace(sessions: SessionView[], connectorId: string): string | null {
  return sessions.find((item) => item.connectorId === connectorId && item.cwd)?.cwd ?? null;
}
