import { cn } from "@/lib/utils";

export interface PasswordStrengthProps {
  score: number;
  label: string;
  className?: string;
}

const strengthColors = [
  "var(--border-md)",
  "oklch(0.72 0.16 25)",
  "oklch(0.78 0.14 60)",
  "oklch(0.78 0.14 95)",
  "oklch(0.72 0.14 152)"
] as const;

export function PasswordStrength({
  score,
  label,
  className
}: PasswordStrengthProps) {
  return (
    <div className={cn("mt-0.5 flex flex-col gap-1", className)}>
      <div className="flex gap-[3px]" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <i
            key={index}
            className="h-[3px] flex-1 rounded-sm transition-colors"
            style={{
              background: index < score ? strengthColors[score] : "var(--border-md)"
            }}
          />
        ))}
      </div>
      <span className="font-mono text-[var(--fs-xs)] text-[var(--text-mut)]">
        {label}
      </span>
    </div>
  );
}
