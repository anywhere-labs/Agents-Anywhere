import { useState, type ReactNode } from "react";
import { Icons, KlawMark } from "../../components/Icons";
import { Identicon } from "../../components/Identicon";
import { AAWord } from "../auth/AAWord";
import type { AuthMe, ConnectorView, SessionView } from "../../lib/api";
import { UserMenu } from "./UserMenu";
import type { FilterState } from "./FilterMenu";

type SidebarProps = {
  me: AuthMe;
  onLogout: () => void;
  onOpenSettings: () => void;
  onOpenTeam: () => void;
  onOpenService: () => void;
  // Devices section (from main)
  connectors: ConnectorView[];
  activeDeviceId: string | null;
  onPickDevice: (id: string) => void;
  onNewDevice: () => void;
  canStartSession: boolean;
  onNewSession: () => void;
  // Sessions sections + collapse / mini / filter / row-menu
  sessions: SessionView[];
  sessionsLoading: boolean;
  activeId: string | null;
  onPickSession: (id: string) => void;
  onToggleCollapse: () => void;
  openSections: { devices: boolean; pinned: boolean; recents: boolean };
  toggleSection: (k: "devices" | "pinned" | "recents") => void;
  filters: FilterState;
  hasFilters: boolean;
  onShowFilter: (anchor: HTMLElement) => void;
  onHideFilter: () => void;
  onMarkVisibleRead: (ids: string[]) => void;
  rowMenuId: string | null;
  onOpenRowMenu: (id: string, anchor: HTMLElement) => void;
  mini?: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

type SectionProps = {
  label: string;
  open: boolean;
  onToggle: () => void;
  action?: SectionAction | SectionAction[];
  children: ReactNode;
};

type SectionAction = {
  icon: ReactNode;
  title: string;
  className?: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseEnter?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseLeave?: () => void;
};

function SidebarSection({ label, open, onToggle, action, children }: SectionProps) {
  const actions = action ? (Array.isArray(action) ? action : [action]) : [];
  return (
    <>
      <div className="kl-sb-section" onClick={onToggle}>
        <span className={`chev${open ? "" : " closed"}`}>
          <Icons.ChevDown size={11} />
        </span>
        <h4>{label}</h4>
        {actions.length > 0 && (
          <div className="section-actions">
            {actions.map((item) => (
              <button
                key={item.title}
                type="button"
                className={`act${item.className ? " " + item.className : ""}`}
                title={item.title}
                onClick={(e) => {
                  e.stopPropagation();
                  item.onClick(e);
                }}
                onMouseEnter={item.onMouseEnter}
                onMouseLeave={item.onMouseLeave}
              >
                {item.icon}
              </button>
            ))}
          </div>
        )}
      </div>
      {open && children}
    </>
  );
}

type SidebarEmptyProps = {
  title: ReactNode;
  onAction?: () => void;
};

function SidebarEmpty({ title, onAction }: SidebarEmptyProps) {
  const clickable = !!onAction;
  return (
    <div
      className={"kl-sb-empty" + (clickable ? " clickable" : "")}
      onClick={
        clickable
          ? (e) => {
              e.stopPropagation();
              onAction!();
            }
          : undefined
      }
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
    >
      {title}
    </div>
  );
}

function SessionRowSkeletons({ count }: { count: number }) {
  return (
    <div className="kl-sess-list">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="kl-sess kl-sess-skel">
          <span className="kl-skel kl-sess-skel-dot" />
          <span className="kl-skel kl-sess-skel-title" style={{ width: `${55 + ((i * 11) % 30)}%` }} />
        </div>
      ))}
    </div>
  );
}

type SessionRowProps = {
  session: SessionView;
  active: boolean;
  menuOpen: boolean;
  onPick: (id: string) => void;
  onOpenMenu: (id: string, anchor: HTMLElement) => void;
};

function SessionRow({
  session,
  active,
  menuOpen,
  onPick,
  onOpenMenu,
}: SessionRowProps) {
  const waiting = session.status === "waiting_approval";
  const attention = waiting || session.unread;
  const cls = [
    "kl-sess",
    active ? "active" : "",
    attention ? "attention" : "",
    waiting ? "waiting" : "",
    session.archived ? "archived" : "",
    menuOpen ? "menu-open" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const dotTitle = waiting
    ? "Waiting for approval"
    : session.unread
      ? "Unread updates"
      : "Idle";
  return (
    <div className={cls} onClick={() => onPick(session.id)}>
      <span className="dot" title={dotTitle} />
      <span className="title">{session.title || "Untitled session"}</span>
      <button
        type="button"
        className="more"
        title="Session options"
        onClick={(e) => {
          e.stopPropagation();
          onOpenMenu(session.id, e.currentTarget);
        }}
      >
        <Icons.More size={14} />
      </button>
    </div>
  );
}

function matchesFilter(s: SessionView, f: FilterState): boolean {
  if (f.device !== "all" && s.connectorId !== f.device) return false;
  if (f.agent !== "all" && s.runtime !== f.agent) return false;
  if (f.status === "active" && s.archived) return false;
  if (f.status === "archived" && !s.archived) return false;
  if (f.workspace !== "all") {
    const ws = workspaceKey(s.cwd);
    if (ws !== f.workspace) return false;
  }
  return true;
}

export function workspaceKey(cwd: string | null): string {
  if (!cwd) return "(none)";
  const trimmed = cwd.replace(/\/+$/, "");
  const last = trimmed.split("/").filter(Boolean).pop();
  return last || "/";
}

export function Sidebar({
  me,
  onLogout,
  onOpenSettings,
  onOpenTeam,
  onOpenService,
  connectors,
  activeDeviceId,
  onPickDevice,
  onNewDevice,
  canStartSession,
  onNewSession,
  sessions,
  sessionsLoading,
  activeId,
  onPickSession,
  onToggleCollapse,
  openSections,
  toggleSection,
  filters,
  hasFilters,
  onShowFilter,
  onHideFilter,
  onMarkVisibleRead,
  rowMenuId,
  onOpenRowMenu,
  mini = false,
  onMouseEnter,
  onMouseLeave,
}: SidebarProps) {
  const [userMenu, setUserMenu] = useState(false);

  const roleLabel = me.role === "admin" ? "Admin" : "Member";

  // The status / device / agent / workspace filter applies to BOTH Pinned and
  // Recents. Otherwise archiving a pinned session has no visible effect (it
  // stays in Pinned) — which reads as a broken button.
  const visible = sessions.filter((s) => matchesFilter(s, filters));
  const pinned = visible.filter((s) => s.pinned);
  const recents = visible.filter((s) => !s.pinned);
  const unreadVisibleIds = visible.filter((s) => s.unread).map((s) => s.id);
  const noSessionsAtAll = sessions.length === 0;

  return (
    <div
      className={`kl-sb${mini ? " kl-sb-mini" : ""}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {!mini && (
        <div className="kl-sb-hd">
          <div className="brand">
            <KlawMark size={20} />
            <AAWord />
          </div>
          <div className="acts">
            <button
              type="button"
              className="kl-iconbtn"
              title="Search · ⌘K"
              disabled
              style={{ opacity: 0.4, cursor: "not-allowed" }}
            >
              <Icons.Search size={15} />
            </button>
            <button
              type="button"
              className="kl-iconbtn"
              title="Collapse sidebar"
              onClick={onToggleCollapse}
            >
              <Icons.Sidebar size={15} />
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        className="kl-sb-new"
        title={
          canStartSession
            ? "Start a new session"
            : "Start by adding an online device"
        }
        onClick={onNewSession}
      >
        <Icons.Plus size={15} />
        <span>New session</span>
        <span className="shortcut">⌘N</span>
      </button>

      {mini && (
        <button
          type="button"
          className="kl-sb-new"
          disabled
          title="Search not yet implemented"
        >
          <Icons.Search size={14} />
          <span>Search</span>
          <span className="shortcut">⌘K</span>
        </button>
      )}

      <div className="kl-sb-scroll">
        {!mini && (
          <SidebarSection
            label="Devices"
            open={openSections.devices}
            onToggle={() => toggleSection("devices")}
            action={{
              icon: <Icons.Plus size={13} />,
              title: "Pair a new device",
              onClick: onNewDevice,
            }}
          >
            {connectors.length === 0 ? (
              <SidebarEmpty
                title={
                  <>
                    Click <span className="here">here</span> to pair a device
                  </>
                }
                onAction={onNewDevice}
              />
            ) : (
              connectors.map((c) => (
                <div
                  key={c.id}
                  className={
                    "kl-dev " +
                    c.status +
                    (activeDeviceId === c.id ? " active" : "")
                  }
                  onClick={() => onPickDevice(c.id)}
                >
                  <span className="status" />
                  <span className="name">{c.name}</span>
                </div>
              ))
            )}
          </SidebarSection>
        )}

        {pinned.length > 0 && (
          <SidebarSection
            label="Pinned"
            open={openSections.pinned}
            onToggle={() => toggleSection("pinned")}
          >
            <div className="kl-sess-list">
              {pinned.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={s.id === activeId}
                  menuOpen={rowMenuId === s.id}
                  onPick={onPickSession}
                  onOpenMenu={onOpenRowMenu}
                />
              ))}
            </div>
          </SidebarSection>
        )}

        <SidebarSection
          label="Recents"
          open={openSections.recents}
          onToggle={() => toggleSection("recents")}
          action={
            !noSessionsAtAll
              ? [
                  ...(unreadVisibleIds.length > 0
                    ? [
                        {
                          icon: <Icons.Check size={13} />,
                          title: "Mark visible sessions read",
                          className: "has-filter",
                          onClick: () => onMarkVisibleRead(unreadVisibleIds),
                        },
                      ]
                    : []),
                  {
                    icon: <Icons.Filter size={13} />,
                    title: "Filter recents",
                    className: hasFilters ? "has-filter" : "",
                    onClick: (e) => onShowFilter(e.currentTarget),
                    onMouseEnter: (e) => onShowFilter(e.currentTarget),
                    onMouseLeave: () => onHideFilter(),
                  },
                ]
              : undefined
          }
        >
          {noSessionsAtAll && sessionsLoading ? (
            <SessionRowSkeletons count={6} />
          ) : noSessionsAtAll ? (
            <SidebarEmpty title="No sessions yet" />
          ) : (
            <div className="kl-sess-list">
              {recents.length === 0 ? (
                <div
                  style={{
                    padding: "12px 16px",
                    fontSize: "var(--fs-xs)",
                    color: "var(--text-faint)",
                    fontFamily: "var(--mono)",
                  }}
                >
                  no sessions match filter
                </div>
              ) : (
                recents.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    active={s.id === activeId}
                    menuOpen={rowMenuId === s.id}
                    onPick={onPickSession}
                    onOpenMenu={onOpenRowMenu}
                  />
                ))
              )}
            </div>
          )}
        </SidebarSection>
      </div>

      {!mini && (
        <div className="kl-sb-foot">
          <button
            type="button"
            className="user-btn"
            onClick={() => setUserMenu((v) => !v)}
            title="Account menu"
          >
            {me.avatar ? (
              <img className="avatar-img" src={me.avatar} alt="" />
            ) : (
              <Identicon id={me.userId} size={30} shape="rounded" />
            )}
            <div className="who">
              <div className="name">{me.userId}</div>
              <div className="role">{roleLabel}</div>
            </div>
            <Icons.ChevUp size={13} className="caret" />
          </button>

          {userMenu && (
            <UserMenu
              me={me}
              onClose={() => setUserMenu(false)}
              onOpenSettings={onOpenSettings}
              onOpenTeam={onOpenTeam}
              onOpenService={onOpenService}
              onLogout={onLogout}
            />
          )}
        </div>
      )}
    </div>
  );
}
