"use client";

import { Moon, Sun } from "lucide-react";

export type ThemeMode = "light" | "dark";

export interface ThemeSegmentProps {
  value: ThemeMode;
  onValueChange: (theme: ThemeMode) => void;
  label?: string;
  lightLabel?: string;
  darkLabel?: string;
}

export function ThemeSegment({
  value,
  onValueChange,
  label = "Color theme",
  lightLabel = "Light mode",
  darkLabel = "Dark mode"
}: ThemeSegmentProps) {
  return (
    <div className="theme-seg" role="group" aria-label={label}>
      <button
        type="button"
        className={value === "light" ? "on" : ""}
        onClick={() => onValueChange("light")}
        aria-label={lightLabel}
        title={lightLabel}
      >
        <Sun size={13} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={value === "dark" ? "on" : ""}
        onClick={() => onValueChange("dark")}
        aria-label={darkLabel}
        title={darkLabel}
      >
        <Moon size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
