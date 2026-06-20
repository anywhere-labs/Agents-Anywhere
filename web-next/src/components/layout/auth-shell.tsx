import type { ReactNode } from "react";
import { BrandWord } from "@/components/layout/brand";

export interface AuthShellProps {
  children: ReactNode;
  actions?: ReactNode;
  serverUrl?: string;
}

export function AuthShell({ children, actions, serverUrl }: AuthShellProps) {
  return (
    <main className="fixed inset-0 flex animate-[klaw-fade-up_0.35s_ease_both] flex-col overflow-auto bg-[var(--bg)]">
      <header className="flex shrink-0 items-center justify-between px-6 py-[18px] text-[length:var(--fs-ui)] text-[color:var(--text-mut)]">
        <div className="flex items-center gap-2.5 text-[color:var(--text)]">
          <BrandWord className="text-[length:22px]" />
        </div>
        {actions ? (
          <div className="flex items-center gap-3.5">{actions}</div>
        ) : null}
      </header>

      <section className="flex min-h-[520px] flex-1 items-center justify-center px-6 pb-16 pt-9">
        {children}
      </section>

      {serverUrl ? (
        <footer className="pointer-events-none fixed inset-x-0 bottom-0 flex items-center justify-between px-6 py-4 font-mono text-[length:var(--fs-xs)] text-[color:var(--text-faint)]">
          <span className="pointer-events-auto inline-flex items-center gap-[7px] rounded-full border border-[var(--border)] bg-[var(--bg-panel)] px-2.5 py-[5px] text-[length:var(--fs-xs)] text-[color:var(--text-mut)]">
            <span className="size-[5px] rounded-full bg-[oklch(0.72_0.14_152)] shadow-[0_0_6px_oklch(0.72_0.14_152_/_0.6)] animate-[klaw-pulse_2.2s_ease-in-out_infinite]" />
            <code>{serverUrl}</code>
          </span>
        </footer>
      ) : null}
    </main>
  );
}

export interface AuthCardProps {
  children: ReactNode;
  className?: string;
}

export function AuthCard({ children, className }: AuthCardProps) {
  return (
    <div className={["flex w-[400px] max-w-full flex-col gap-[22px]", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}
