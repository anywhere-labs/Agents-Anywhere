import * as React from "react";
import { cn } from "@/lib/utils";

export interface SurfaceCardProps extends React.HTMLAttributes<HTMLDivElement> {
  padded?: boolean;
}

export function SurfaceCard({
  padded = true,
  className,
  ...props
}: SurfaceCardProps) {
  return (
    <div
      className={cn(
        "rounded-[var(--r)] border border-[var(--border)] bg-[var(--bg-panel)]",
        padded && "p-4",
        className,
      )}
      {...props}
    />
  );
}

export interface PageHeaderProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}

export function PageHeader({
  title,
  description,
  actions,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <div
      className={cn("flex items-start justify-between gap-4", className)}
      {...props}
    >
      <div className="min-w-0">
        <h1 className="m-0 text-[var(--fs-xl)] font-semibold leading-tight text-[var(--text)]">
          {title}
        </h1>
        {description ? (
          <p className="m-0 mt-1 max-w-[72ch] text-[var(--fs-ui)] leading-5 text-[var(--text-mut)]">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

export interface ToolbarProps extends React.HTMLAttributes<HTMLDivElement> {}

export function Toolbar({ className, ...props }: ToolbarProps) {
  return (
    <div
      className={cn("flex min-h-9 items-center gap-2", className)}
      {...props}
    />
  );
}

export interface KeyValueListProps extends React.HTMLAttributes<HTMLDListElement> {}

export function KeyValueList({ className, ...props }: KeyValueListProps) {
  return (
    <dl
      className={cn(
        "grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2 text-[var(--fs-sm)]",
        className,
      )}
      {...props}
    />
  );
}

export interface KeyValueItemProps {
  label: React.ReactNode;
  children: React.ReactNode;
}

export function KeyValueItem({ label, children }: KeyValueItemProps) {
  return (
    <>
      <dt className="text-[var(--text-mut)]">{label}</dt>
      <dd className="m-0 min-w-0 text-[var(--text-mid)]">{children}</dd>
    </>
  );
}
