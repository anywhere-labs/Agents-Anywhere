import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export interface BrandLogoProps {
  size?: number;
  padding?: number;
  className?: string;
}

export function BrandLogo({
  size = 24,
  padding = 0.14,
  className
}: BrandLogoProps) {
  const style = {
    "--aa-logo-size": `${size}px`,
    "--aa-logo-padding": `${Math.max(0, Math.min(padding, 0.4)) * 100}%`
  } as CSSProperties;

  return (
    <span
      className={cn("aa-logo", className)}
      style={style}
      aria-hidden="true"
    >
      <img
        className="aa-logo-img aa-logo-dark-mode"
        src="/brand/aa-logo-dark-mode.png"
        alt=""
        draggable={false}
      />
      <img
        className="aa-logo-img aa-logo-light-mode"
        src="/brand/aa-logo-light-mode.png"
        alt=""
        draggable={false}
      />
    </span>
  );
}

export interface BrandWordProps {
  className?: string;
  children?: string;
}

export function BrandWord({
  className,
  children = "Agents Anywhere"
}: BrandWordProps) {
  return (
    <span
      className={cn(
        "aa-brand-word whitespace-nowrap text-[length:22px] text-[color:var(--text)]",
        className,
      )}
    >
      {children}
    </span>
  );
}
