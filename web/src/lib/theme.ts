import { useEffect, useState } from "react";

const KEY = "aa.theme.v1";
export type Theme = "auto" | "dark" | "light";

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "auto" || stored === "light" || stored === "dark") return stored;
  } catch {
    /* ignore */
  }
  return "auto";
}

function systemTheme(): "dark" | "light" {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => readTheme());

  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = theme === "auto" ? systemTheme() : theme;
    };
    apply();
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* ignore */
    }
    if (theme !== "auto") return;
    const query = window.matchMedia?.("(prefers-color-scheme: light)");
    query?.addEventListener("change", apply);
    return () => query?.removeEventListener("change", apply);
  }, [theme]);

  return [theme, setTheme];
}
