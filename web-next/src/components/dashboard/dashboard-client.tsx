"use client";

import * as React from "react";
import {
  ChevronDown,
  LogOut,
  Monitor,
  PanelLeft,
  Plus,
  RefreshCcw,
  Search,
  Settings,
  Users
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  ConfirmDialog,
  EmptyState,
  Identicon,
  LoadingState,
  RuntimeBadge,
  StatusBadge,
  Tag
} from "@/components/common";
import {
  AppShell,
  BrandWord,
  DetailHeader,
  MainPanel,
  SidebarShell,
  ThemeSegment,
  type ThemeMode
} from "@/components/layout";
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

export function DashboardClient() {
  const t = useTranslations("dashboard");
  const common = useTranslations("common");
  const [theme, setTheme] = React.useState<ThemeMode>("dark");
  const [authState, setAuthState] = React.useState<DashboardAuthState>(() => {
    const session = loadStoredSession();
    return session ? { kind: "checking" } : { kind: "auth" };
  });
  const [connectors, setConnectors] = React.useState<ConnectorView[]>([]);
  const [sessions, setSessions] = React.useState<SessionView[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [collapsed, setCollapsed] = React.useState(false);
  const [signOutOpen, setSignOutOpen] = React.useState(false);

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  React.useEffect(() => {
    if (authState.kind !== "checking") return;
    const session = loadStoredSession();
    if (!session) {
      setAuthState({ kind: "auth" });
      return;
    }

    let cancelled = false;
    authApi
      .me(session.accessToken)
      .then((me) => {
        if (!cancelled) setAuthState({ kind: "ready", session, me });
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

  const session = authState.kind === "ready" ? authState.session : null;

  const refreshDashboard = React.useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const [connectorResult, sessionResult] = await Promise.all([
        dashboardApi.listConnectors(session.accessToken),
        dashboardApi.listSessions(session.accessToken)
      ]);
      setConnectors(sortConnectors(connectorResult.connectors));
      setSessions(sortSessions(sessionResult.sessions));
      setSelectedId((current) => {
        if (current && sessionResult.sessions.some((item) => item.id === current)) {
          return current;
        }
        return sessionResult.sessions[0]?.id ?? null;
      });
    } catch (err) {
      setError(errorMessage(err, t("errors.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [session, t]);

  React.useEffect(() => {
    void refreshDashboard();
  }, [refreshDashboard]);

  React.useEffect(() => {
    if (authState.kind !== "auth") return;
    window.location.replace(`/${document.documentElement.lang || "en"}/login`);
  }, [authState.kind]);

  const selectedSession =
    selectedId != null
      ? sessions.find((item) => item.id === selectedId) ?? null
      : null;

  if (authState.kind === "checking") {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-[var(--bg)]">
        <LoadingState label={t("status.restoring")} />
      </main>
    );
  }

  if (authState.kind === "auth") {
    return null;
  }

  const signOut = () => {
    clearStoredSession();
    setSignOutOpen(false);
    window.location.replace(`/${document.documentElement.lang || "en"}/login`);
  };

  return (
    <>
      <AppShell
        collapsed={collapsed}
        sidebar={
          <DashboardSidebar
            me={authState.me}
            theme={theme}
            collapsed={collapsed}
            connectors={connectors}
            sessions={sessions}
            loading={loading}
            selectedId={selectedId}
            onSelectSession={setSelectedId}
            onToggleCollapse={() => setCollapsed((next) => !next)}
            onRefresh={() => void refreshDashboard()}
            onSignOut={() => setSignOutOpen(true)}
            onThemeChange={setTheme}
          />
        }
      >
        <MainPanel>
          <DashboardMain
            loading={loading}
            error={error}
            sessions={sessions}
            connectors={connectors}
            selectedSession={selectedSession}
            onRefresh={() => void refreshDashboard()}
          />
        </MainPanel>
      </AppShell>

      <ConfirmDialog
        open={signOutOpen}
        onOpenChange={setSignOutOpen}
        title={t("signOut.title")}
        description={t("signOut.description")}
        confirmLabel={t("signOut.confirm")}
        cancelLabel={common("cancel")}
        onConfirm={signOut}
      />
    </>
  );
}

type DashboardSidebarProps = {
  me: AuthMe;
  theme: ThemeMode;
  collapsed: boolean;
  connectors: ConnectorView[];
  sessions: SessionView[];
  loading: boolean;
  selectedId: string | null;
  onSelectSession: (id: string) => void;
  onToggleCollapse: () => void;
  onRefresh: () => void;
  onSignOut: () => void;
  onThemeChange: (theme: ThemeMode) => void;
};

function DashboardSidebar({
  me,
  theme,
  collapsed,
  connectors,
  sessions,
  loading,
  selectedId,
  onSelectSession,
  onToggleCollapse,
  onRefresh,
  onSignOut,
  onThemeChange
}: DashboardSidebarProps) {
  const t = useTranslations("dashboard");
  const pinned = sessions.filter((session) => session.pinned && !session.archived);
  const recents = sessions.filter((session) => !session.pinned && !session.archived);

  return (
    <SidebarShell
      mini={collapsed}
      header={
        <div className="flex h-full items-center justify-between gap-1">
          {!collapsed ? <BrandWord className="text-[length:20px]" /> : null}
          <div className="ml-auto flex items-center">
            <IconButton label={t("actions.search")} size="sm" disabled>
              <Search aria-hidden="true" />
            </IconButton>
            <IconButton label={t("actions.collapse")} size="sm" onClick={onToggleCollapse}>
              <PanelLeft aria-hidden="true" />
            </IconButton>
          </div>
        </div>
      }
      footer={
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--r)] border-0 bg-transparent p-1 text-left hover:bg-[var(--bg-hover)]"
          >
            {me.avatar ? (
              <img
                src={me.avatar}
                alt=""
                className="size-[30px] shrink-0 rounded-full object-cover"
              />
            ) : (
              <Identicon id={me.userId} size={30} />
            )}
            {!collapsed ? (
              <span className="min-w-0 flex-1">
                <span className="block overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--fs-ui)] font-medium text-[color:var(--text)]">
                  {me.userId}
                </span>
                <span className="block text-[length:var(--fs-xs)] text-[color:var(--text-mut)]">
                  {me.role === "admin" ? t("roles.admin") : t("roles.member")}
                </span>
              </span>
            ) : null}
          </button>
          {!collapsed ? (
            <ThemeSegment
              value={theme}
              onValueChange={onThemeChange}
              label={t("theme.label")}
              lightLabel={t("theme.light")}
              darkLabel={t("theme.dark")}
            />
          ) : null}
        </div>
      }
    >
      <div className="px-2 pb-2">
        <Button
          type="button"
          variant="ghost"
          className="h-[34px] w-full justify-start px-3 text-[length:var(--fs-ui)] font-medium text-[color:var(--text)]"
          disabled={connectors.length === 0}
        >
          <Plus aria-hidden="true" />
          {!collapsed ? (
            <>
              <span>{t("actions.newSession")}</span>
              <span className="ml-auto font-mono text-[length:var(--fs-2xs)] text-[color:var(--text-faint)]">
                ⌘N
              </span>
            </>
          ) : null}
        </Button>
      </div>

      {!collapsed ? (
        <div className="min-h-0">
          <SidebarSection title={t("sections.devices")} action={onRefresh}>
            {connectors.length === 0 ? (
              <SidebarEmpty>{t("empty.noDevices")}</SidebarEmpty>
            ) : (
              connectors.map((connector) => (
                <DeviceRow key={connector.id} connector={connector} />
              ))
            )}
          </SidebarSection>

          <SidebarSection title={t("sections.pinned")}>
            {loading ? (
              <SidebarSkeleton />
            ) : pinned.length === 0 ? (
              <SidebarEmpty>{t("empty.noPinned")}</SidebarEmpty>
            ) : (
              pinned.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={session.id === selectedId}
                  onSelect={onSelectSession}
                />
              ))
            )}
          </SidebarSection>

          <SidebarSection title={t("sections.recents")}>
            {loading ? (
              <SidebarSkeleton />
            ) : recents.length === 0 ? (
              <SidebarEmpty>{t("empty.noSessions")}</SidebarEmpty>
            ) : (
              recents.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={session.id === selectedId}
                  onSelect={onSelectSession}
                />
              ))
            )}
          </SidebarSection>

          <div className="mt-3 border-t border-[var(--border)] px-2 pt-2">
            <SidebarAction icon={<Users aria-hidden="true" />} label={t("nav.team")} disabled />
            <SidebarAction icon={<Settings aria-hidden="true" />} label={t("nav.settings")} disabled />
            <SidebarAction icon={<LogOut aria-hidden="true" />} label={t("actions.signOut")} onClick={onSignOut} />
          </div>
        </div>
      ) : null}
    </SidebarShell>
  );
}

function SidebarSection({
  title,
  action,
  children
}: {
  title: React.ReactNode;
  action?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mx-0.5 flex items-center gap-1.5 px-3 pb-1 pt-3.5">
        <ChevronDown className="size-3 text-[color:var(--text-faint)]" aria-hidden="true" />
        <h2 className="m-0 text-[length:var(--fs-xs)] font-medium text-[color:var(--text-faint)]">
          {title}
        </h2>
        {action ? (
          <button
            type="button"
            className="ml-auto inline-flex size-5 items-center justify-center rounded-[5px] border-0 bg-transparent p-0 text-[color:var(--text-mut)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text)]"
            onClick={action}
          >
            <RefreshCcw className="size-3" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function SidebarEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-2 mb-1 rounded-md px-2 py-1.5 text-[length:var(--fs-xs)] leading-[1.3] text-[color:var(--text-mut)]">
      {children}
    </div>
  );
}

function SidebarSkeleton() {
  return (
    <div className="flex flex-col px-2">
      {[0, 1, 2].map((item) => (
        <div key={item} className="mb-px flex h-8 items-center gap-2 rounded-[7px] px-2">
          <span className="size-1.5 rounded-full bg-[var(--bg-elev)]" />
          <span className="h-3 rounded bg-[var(--bg-elev)]" style={{ width: `${58 + item * 12}%` }} />
        </div>
      ))}
    </div>
  );
}

function DeviceRow({ connector }: { connector: ConnectorView }) {
  return (
    <div className="mx-2 mb-px flex h-8 items-center gap-2 rounded-[7px] px-2 text-[length:var(--fs-ui)] text-[color:var(--text-mid)] hover:bg-[var(--bg-hover)]">
      <span
        className={cn(
          "size-1.5 rounded-full",
          connector.status === "online" ? "bg-[oklch(0.72_0.14_152)]" : "bg-[var(--text-faint)]",
        )}
      />
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {connector.name}
      </span>
    </div>
  );
}

function SessionRow({
  session,
  active,
  onSelect
}: {
  session: SessionView;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const waiting = session.status === "waiting_approval";
  const attention = waiting || session.unread;
  return (
    <button
      type="button"
      className={cn(
        "mx-2 mb-px flex h-8 w-[calc(100%-16px)] items-center gap-2 rounded-[7px] border-0 bg-transparent px-2 text-left hover:bg-[var(--bg-hover)]",
        active && "bg-[var(--bg-active)]",
      )}
      onClick={() => onSelect(session.id)}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full border border-[var(--text-faint)]",
          attention && "border-transparent bg-[var(--accent)]",
          waiting && "bg-[var(--info)]",
        )}
      />
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--fs-ui)] text-[color:var(--text)]">
        {session.title || "Untitled session"}
      </span>
    </button>
  );
}

function SidebarAction({
  icon,
  label,
  onClick,
  disabled = false
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="mb-px flex h-8 w-full items-center gap-2 rounded-[7px] border-0 bg-transparent px-2 text-left text-[length:var(--fs-ui)] text-[color:var(--text-mid)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text)] disabled:cursor-not-allowed disabled:opacity-45"
      onClick={onClick}
      disabled={disabled}
    >
      <span className="[&_svg]:size-4">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

type DashboardMainProps = {
  loading: boolean;
  error: string | null;
  sessions: SessionView[];
  connectors: ConnectorView[];
  selectedSession: SessionView | null;
  onRefresh: () => void;
};

function DashboardMain({
  loading,
  error,
  sessions,
  connectors,
  selectedSession,
  onRefresh
}: DashboardMainProps) {
  const t = useTranslations("dashboard");

  if (loading && sessions.length === 0) {
    return <LoadingState className="h-full" label={t("status.loadingDashboard")} />;
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          title={t("errors.title")}
          description={error}
          action={
            <Button type="button" variant="emphasis" onClick={onRefresh}>
              <RefreshCcw aria-hidden="true" />
              {t("actions.retry")}
            </Button>
          }
        />
      </div>
    );
  }

  if (!selectedSession) {
    return (
      <div className="flex h-full flex-col bg-[var(--bg)]">
        <DetailHeader
          title={t("empty.title")}
          actions={
            <Button type="button" variant="normal" size="sm" onClick={onRefresh}>
              <RefreshCcw aria-hidden="true" />
              {t("actions.refresh")}
            </Button>
          }
        />
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <EmptyState
            title={connectors.length === 0 ? t("empty.noDevicesTitle") : t("empty.noSessionsTitle")}
            description={connectors.length === 0 ? t("empty.noDevicesDescription") : t("empty.noSessionsDescription")}
            action={
              <Button type="button" variant="emphasis" disabled={connectors.length === 0}>
                <Plus aria-hidden="true" />
                {t("actions.newSession")}
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[var(--bg)]">
      <DetailHeader
        title={selectedSession.title || "Untitled session"}
        chips={
          <>
            <RuntimeBadge runtime={selectedSession.runtime} />
            <StatusBadge tone={statusTone(selectedSession.status)}>
              {t(`sessionStatus.${selectedSession.status}`)}
            </StatusBadge>
            {selectedSession.cwd ? <Tag>{workspaceLabel(selectedSession.cwd)}</Tag> : null}
          </>
        }
        actions={
          <Button type="button" variant="normal" size="sm" onClick={onRefresh}>
            <RefreshCcw aria-hidden="true" />
            {t("actions.refresh")}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="grid max-w-5xl gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)]">
          <section className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--bg-panel)] p-4">
            <div className="mb-4 flex items-center gap-2">
              <Monitor className="size-4 text-[color:var(--text-mut)]" aria-hidden="true" />
              <h2 className="m-0 text-[length:var(--fs-md)] font-semibold text-[color:var(--text)]">
                {t("session.overview")}
              </h2>
            </div>
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-3 text-[length:var(--fs-sm)]">
              <Meta label={t("session.runtime")} value={selectedSession.runtime} mono />
              <Meta label={t("session.device")} value={connectorName(connectors, selectedSession.connectorId)} />
              <Meta label={t("session.workspace")} value={selectedSession.cwd ?? t("session.none")} mono />
              <Meta label={t("session.external")} value={selectedSession.externalSessionId ?? t("session.none")} mono />
              <Meta label={t("session.updated")} value={formatDate(selectedSession.sortAt ?? selectedSession.lastActivityAt)} />
            </dl>
          </section>

          <section className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--bg-panel)] p-4">
            <h2 className="m-0 text-[length:var(--fs-md)] font-semibold text-[color:var(--text)]">
              {t("session.next")}
            </h2>
            <p className="m-0 mt-2 text-[length:var(--fs-sm)] leading-5 text-[color:var(--text-mut)]">
              {t("session.nextDescription")}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

function Meta({
  label,
  value,
  mono = false
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="text-[color:var(--text-mut)]">{label}</dt>
      <dd className={cn("m-0 min-w-0 text-[color:var(--text-mid)]", mono && "font-mono")}>
        {value}
      </dd>
    </>
  );
}

function sortConnectors(connectors: ConnectorView[]): ConnectorView[] {
  return [...connectors].sort((a, b) => {
    if (a.status !== b.status) return a.status === "online" ? -1 : 1;
    return a.name.localeCompare(b.name);
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

function connectorName(connectors: ConnectorView[], connectorId: string): string {
  return connectors.find((connector) => connector.id === connectorId)?.name ?? shortId(connectorId);
}

function shortId(value: string): string {
  return value.length > 10 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function workspaceLabel(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  return trimmed.split("/").filter(Boolean).pop() || "/";
}

function statusTone(status: SessionView["status"]): "neutral" | "info" | "success" | "warning" | "danger" {
  if (status === "running") return "success";
  if (status === "waiting_approval") return "info";
  if (status === "error") return "danger";
  return "neutral";
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}
