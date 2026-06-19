import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface AppShellProps {
  sidebar?: ReactNode;
  children: ReactNode;
  collapsed?: boolean;
  className?: string;
}

export function AppShell({
  sidebar,
  children,
  collapsed = false,
  className
}: AppShellProps) {
  return (
    <main
      className={cn(
        "flex h-screen w-screen gap-2.5 overflow-hidden bg-[var(--bg)] p-2.5 text-[var(--text)]",
        !sidebar && "pl-0",
        className,
      )}
      data-sidebar-collapsed={collapsed ? "true" : "false"}
    >
      {sidebar}
      {children}
    </main>
  );
}

export interface MainPanelProps {
  children: ReactNode;
  className?: string;
}

export function MainPanel({ children, className }: MainPanelProps) {
  return (
    <section
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--bg-panel)]",
        className,
      )}
    >
      {children}
    </section>
  );
}

export interface SidebarShellProps {
  children: ReactNode;
  footer?: ReactNode;
  header?: ReactNode;
  mini?: boolean;
  className?: string;
}

export function SidebarShell({
  children,
  footer,
  header,
  mini = false,
  className
}: SidebarShellProps) {
  return (
    <aside
      className={cn(
        "relative flex min-h-0 shrink-0 flex-col overflow-visible rounded-[12px] border border-[var(--border)] bg-[var(--bg-panel)] shadow-[0_1px_3px_rgba(0,0,0,0.18),0_8px_24px_-16px_rgba(0,0,0,0.4)]",
        mini ? "w-[54px]" : "w-[252px]",
        className,
      )}
    >
      {header ? <div className="h-[50px] shrink-0 px-2">{header}</div> : null}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">{children}</div>
      {footer ? <div className="shrink-0 p-2">{footer}</div> : null}
    </aside>
  );
}

export interface DetailHeaderProps {
  title: ReactNode;
  leading?: ReactNode;
  chips?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function DetailHeader({
  title,
  leading,
  chips,
  actions,
  className
}: DetailHeaderProps) {
  return (
    <header
      className={cn(
        "flex h-[46px] shrink-0 items-center gap-2.5 border-b border-[var(--border)] px-3 pl-4",
        className,
      )}
    >
      {leading}
      <div className="inline-flex min-w-0 shrink items-center gap-2">
        <h1 className="m-0 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--fs-base)] font-medium text-[var(--text)]">
          {title}
        </h1>
      </div>
      {chips ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {chips}
        </div>
      ) : (
        <div className="min-w-0 flex-1" />
      )}
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </header>
  );
}
