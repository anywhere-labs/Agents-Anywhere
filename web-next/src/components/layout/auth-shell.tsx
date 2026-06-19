import type { ReactNode } from "react";
import { BrandWord } from "@/components/layout/brand";
import { Pill } from "@/components/common";

export interface AuthShellProps {
  children: ReactNode;
  actions?: ReactNode;
  serverUrl?: string;
}

export function AuthShell({ children, actions, serverUrl }: AuthShellProps) {
  return (
    <main className="fixed inset-0 flex animate-[klaw-fade-up_0.35s_ease_both] flex-col overflow-auto bg-[var(--bg)]">
      <header className="flex shrink-0 items-center justify-between px-6 py-[18px] text-[var(--fs-ui)] text-[var(--text-mut)]">
        <div className="flex items-center gap-2.5 text-[var(--text)]">
          <BrandWord className="text-[22px]" />
        </div>
        {actions ? (
          <div className="flex items-center gap-3.5">{actions}</div>
        ) : null}
      </header>

      <section className="flex min-h-[520px] flex-1 items-center justify-center px-6 pb-16 pt-9">
        {children}
      </section>

      {serverUrl ? (
        <footer className="pointer-events-none fixed inset-x-0 bottom-0 flex items-center justify-between px-6 py-[18px] text-[var(--fs-xs)] text-[var(--text-mut)]">
          <Pill mono className="pointer-events-auto">
            <span className="size-1.5 rounded-full bg-[oklch(0.72_0.14_152)]" />
            <code>{serverUrl}</code>
          </Pill>
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
