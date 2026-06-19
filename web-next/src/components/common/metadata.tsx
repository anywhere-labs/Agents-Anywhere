import * as React from "react";
import { X } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const compactBase =
  "inline-flex max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap border align-middle leading-none transition-colors [&_svg]:size-3 [&_svg]:shrink-0";

const pillVariants = cva(compactBase, {
  variants: {
    variant: {
      default:
        "h-[22px] rounded-[5px] border-[var(--border)] bg-[var(--bg-elev)] px-2 text-[var(--fs-xs)] text-[var(--text-mid)]",
      muted:
        "h-[22px] rounded-[5px] border-transparent bg-transparent px-1.5 text-[var(--fs-xs)] text-[var(--text-mut)]",
      outline:
        "h-[22px] rounded-[5px] border-[var(--border-md)] bg-transparent px-2 text-[var(--fs-xs)] text-[var(--text-mid)]",
      accent:
        "h-[22px] rounded-[5px] border-[color-mix(in_oklch,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] px-2 text-[var(--fs-xs)] text-[var(--text)]"
    },
    mono: {
      true: "font-mono",
      false: ""
    }
  },
  defaultVariants: {
    variant: "default",
    mono: false
  }
});

export interface PillProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof pillVariants> {}

export function Pill({ className, variant, mono, ...props }: PillProps) {
  return (
    <span
      className={cn(pillVariants({ variant, mono, className }))}
      {...props}
    />
  );
}

const chipVariants = cva(compactBase, {
  variants: {
    variant: {
      default:
        "h-7 rounded-md border-[var(--border-md)] bg-[var(--bg-elev)] px-2 text-[var(--fs-sm)] text-[var(--text-mid)] hover:border-[var(--border-lg)] hover:text-[var(--text)]",
      selected:
        "h-7 rounded-md border-[color-mix(in_oklch,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] px-2 text-[var(--fs-sm)] text-[var(--text)]",
      subtle:
        "h-7 rounded-md border-transparent bg-[var(--bg-hover)] px-2 text-[var(--fs-sm)] text-[var(--text-mut)] hover:text-[var(--text-mid)]"
    },
    interactive: {
      true: "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
      false: ""
    }
  },
  defaultVariants: {
    variant: "default",
    interactive: false
  }
});

export interface ChipProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof chipVariants> {
  onRemove?: () => void;
  removeLabel?: string;
}

export function Chip({
  children,
  className,
  variant,
  interactive,
  onRemove,
  removeLabel = "Remove",
  ...props
}: ChipProps) {
  return (
    <span
      className={cn(
        chipVariants({ variant, interactive: interactive || !!onRemove, className }),
      )}
      {...props}
    >
      <span className="min-w-0 overflow-hidden text-ellipsis">{children}</span>
      {onRemove ? (
        <button
          type="button"
          className="-mr-1 inline-flex size-5 items-center justify-center rounded text-[var(--text-mut)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          aria-label={removeLabel}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

const tagVariants = cva(compactBase, {
  variants: {
    tone: {
      neutral:
        "h-5 rounded px-1.5 text-[var(--fs-2xs)] border-[var(--border)] bg-[var(--bg-elev)] text-[var(--text-mut)]",
      accent:
        "h-5 rounded px-1.5 text-[var(--fs-2xs)] border-[color-mix(in_oklch,var(--accent)_30%,transparent)] bg-[var(--accent-soft)] text-[var(--text-mid)]",
      danger:
        "h-5 rounded px-1.5 text-[var(--fs-2xs)] border-[oklch(0.72_0.16_25_/_0.32)] bg-[oklch(0.72_0.16_25_/_0.12)] text-[var(--text-mid)]"
    }
  },
  defaultVariants: {
    tone: "neutral"
  }
});

export interface TagProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof tagVariants> {}

export function Tag({ className, tone, ...props }: TagProps) {
  return <span className={cn(tagVariants({ tone, className }))} {...props} />;
}

const statusTone = {
  neutral: {
    dot: "var(--text-faint)",
    border: "var(--border)",
    background: "var(--bg-elev)"
  },
  info: {
    dot: "var(--info)",
    border: "color-mix(in oklch, var(--info) 35%, transparent)",
    background: "var(--info-soft)"
  },
  success: {
    dot: "oklch(0.72 0.14 152)",
    border: "oklch(0.72 0.14 152 / 0.35)",
    background: "oklch(0.72 0.14 152 / 0.12)"
  },
  warning: {
    dot: "var(--accent)",
    border: "color-mix(in oklch, var(--accent) 35%, transparent)",
    background: "var(--accent-soft)"
  },
  danger: {
    dot: "oklch(0.72 0.16 25)",
    border: "oklch(0.72 0.16 25 / 0.35)",
    background: "oklch(0.72 0.16 25 / 0.12)"
  }
} satisfies Record<
  string,
  { dot: string; border: string; background: string }
>;

type StatusTone = keyof typeof statusTone;

export interface StatusBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
  dot?: boolean;
}

export function StatusBadge({
  children,
  className,
  tone = "neutral",
  dot = true,
  style,
  ...props
}: StatusBadgeProps) {
  const colors = statusTone[tone];
  return (
    <span
      className={cn(
        compactBase,
        "h-[22px] rounded-[5px] px-2 text-[var(--fs-xs)] text-[var(--text-mid)]",
        className,
      )}
      style={{
        borderColor: colors.border,
        background: colors.background,
        ...style
      }}
      {...props}
    >
      {dot ? (
        <span
          className="size-[5px] rounded-full"
          style={{ background: colors.dot }}
          aria-hidden="true"
        />
      ) : null}
      {children}
    </span>
  );
}

const runtimeColors = {
  claude: "var(--agent-claude)",
  codex: "var(--agent-codex)",
  opencode: "var(--agent-opencode)",
  cursor: "var(--agent-cursor)"
} as const;

export type RuntimeName = keyof typeof runtimeColors | (string & {});

export interface RuntimeBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  runtime: RuntimeName;
  label?: React.ReactNode;
}

export function RuntimeBadge({
  runtime,
  label,
  className,
  style,
  ...props
}: RuntimeBadgeProps) {
  const key = runtime.toLowerCase() as keyof typeof runtimeColors;
  const color = runtimeColors[key] ?? "var(--text-faint)";

  return (
    <span
      className={cn(
        compactBase,
        "h-[22px] rounded-[5px] border-[var(--border)] bg-[var(--bg-elev)] px-2 font-mono text-[var(--fs-xs)] text-[var(--text-mid)]",
        className,
      )}
      style={style}
      {...props}
    >
      <span
        className="size-[5px] rounded-full"
        style={{ background: color }}
        aria-hidden="true"
      />
      {label ?? runtime}
    </span>
  );
}

export interface CountBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  value: React.ReactNode;
}

export function CountBadge({ value, className, ...props }: CountBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex min-w-4 items-center justify-center rounded px-1 font-mono text-[var(--fs-2xs)] leading-none text-[var(--text-faint)]",
        className,
      )}
      {...props}
    >
      {value}
    </span>
  );
}
