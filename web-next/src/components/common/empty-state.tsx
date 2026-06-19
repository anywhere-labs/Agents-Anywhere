import * as React from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex min-h-40 flex-col items-center justify-center gap-3 rounded-[var(--r)] border border-dashed border-[var(--border)] px-6 py-8 text-center",
        className,
      )}
      {...props}
    >
      {icon ? (
        <div className="flex size-9 items-center justify-center rounded-[var(--r)] border border-[var(--border)] bg-[var(--bg-elev)] text-[var(--text-mut)] [&_svg]:size-4">
          {icon}
        </div>
      ) : null}
      <div>
        <h3 className="m-0 text-[var(--fs-md)] font-medium text-[var(--text)]">
          {title}
        </h3>
        {description ? (
          <p className="m-0 mt-1 max-w-[44ch] text-[var(--fs-sm)] leading-5 text-[var(--text-mut)]">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export interface LoadingStateProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: React.ReactNode;
}

export function LoadingState({
  label = "Loading",
  className,
  ...props
}: LoadingStateProps) {
  return (
    <div
      className={cn(
        "flex min-h-24 items-center justify-center gap-2 text-[var(--fs-sm)] text-[var(--text-mut)]",
        className,
      )}
      {...props}
    >
      <span className="size-3 animate-[klaw-spin_0.7s_linear_infinite] rounded-full border border-current border-t-transparent" />
      <span>{label}</span>
    </div>
  );
}

export interface SkeletonRowProps extends React.HTMLAttributes<HTMLDivElement> {
  width?: string;
}

export function SkeletonRow({
  width = "70%",
  className,
  style,
  ...props
}: SkeletonRowProps) {
  return (
    <div
      className={cn(
        "h-8 overflow-hidden rounded-md bg-[var(--bg-elev)]",
        className,
      )}
      style={{ width, ...style }}
      {...props}
    >
      <div className="h-full w-full animate-pulse bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.04),transparent)]" />
    </div>
  );
}
