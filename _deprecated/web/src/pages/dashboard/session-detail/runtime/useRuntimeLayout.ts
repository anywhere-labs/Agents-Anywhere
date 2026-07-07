import { useCallback, useMemo, useState } from "react";

export type PanelMode = "none" | "files" | "term" | "both";

/**
 * Pane size state is stored as **ratios (0–1)** rather than absolute px.
 * This keeps the default split visually balanced regardless of container
 * size and survives sidebar / panel toggles cleanly. The caller turns
 * each ratio into `flex-grow` at render time.
 */
export type PaneRatios = {
  /** Vertical split between the top and bottom pane in 2-pane stacks. */
  vSplit: number;
  /** Horizontal split in three-way mode: left-column (files+term) vs preview. */
  hSplit: number;
  /** Inside three-way mode's left column: files vs term. */
  innerVSplit: number;
};

type LayoutState = {
  panel: PanelMode;
  /** Total runtime column width in px. */
  runtimeWidth: number;
  ratios: PaneRatios;
};

const STORAGE_KEY = "aa.runtimeLayout.v2";

const DEFAULT_RUNTIME_WIDTH = 400;

/** Extra px to add when the dashboard sidebar is collapsed — that frees
 * up horizontal space which we reclaim for the runtime panel so the
 * sub-panels visibly widen, matching how Claude Desktop behaves. */
const SIDEBAR_COLLAPSE_BONUS = 60;

const DEFAULT_STATE: LayoutState = {
  panel: "none",
  runtimeWidth: DEFAULT_RUNTIME_WIDTH,
  ratios: { vSplit: 0.5, hSplit: 0.5, innerVSplit: 0.5 },
};

export const RUNTIME_MIN_W = 280;
export const RUNTIME_MAX_W = 1100;
export const RATIO_MIN = 0.12;
export const RATIO_MAX = 0.88;

function loadStored(): LayoutState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<LayoutState>;
    return {
      panel: (parsed.panel ?? DEFAULT_STATE.panel) as PanelMode,
      runtimeWidth:
        typeof parsed.runtimeWidth === "number"
          ? clampWidth(parsed.runtimeWidth)
          : DEFAULT_RUNTIME_WIDTH,
      ratios: {
        vSplit: clampRatio(parsed.ratios?.vSplit ?? 0.5),
        hSplit: clampRatio(parsed.ratios?.hSplit ?? 0.5),
        innerVSplit: clampRatio(parsed.ratios?.innerVSplit ?? 0.5),
      },
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function persist(state: LayoutState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode — ignore */
  }
}

function clampRatio(r: number): number {
  if (Number.isNaN(r)) return 0.5;
  return Math.max(RATIO_MIN, Math.min(RATIO_MAX, r));
}

function clampWidth(w: number): number {
  return Math.max(RUNTIME_MIN_W, Math.min(RUNTIME_MAX_W, w));
}

/**
 * Owns the panel mode, runtime column width, and the three resize ratios
 * (vertical pane split, three-way horizontal split, three-way inner
 * vertical split). Persists to localStorage.
 *
 * When the visible mode (panel + preview) changes, runtimeWidth snaps to
 * either the user's previously-dragged value for that combination, or
 * the mode's default. After the user manually drags the column, that
 * value is remembered for the same combination next time.
 *
 * `sidebarCollapsed`: when true, runtime panels widen by a fixed bonus
 * to reclaim the horizontal space that the (now hidden) sidebar would
 * have taken. Matches Claude Desktop's behaviour.
 */
export function useRuntimeLayout(
  sidebarCollapsed: boolean = false,
) {
  const [state, setState] = useState<LayoutState>(() => loadStored());

  const setPanel = useCallback((panel: PanelMode) => {
    setState((prev) => {
      const next = { ...prev, panel };
      persist(next);
      return next;
    });
  }, []);

  const setRuntimeWidth = useCallback(
    (next: number) => {
      setState((prev) => {
        const w = clampWidth(next);
        const updated: LayoutState = {
          ...prev,
          runtimeWidth: w,
        };
        persist(updated);
        return updated;
      });
    },
    [],
  );

  const setRatio = useCallback((key: keyof PaneRatios, value: number) => {
    setState((prev) => {
      const ratios = { ...prev.ratios, [key]: clampRatio(value) };
      const updated = { ...prev, ratios };
      persist(updated);
      return updated;
    });
  }, []);

  const togglePanelFiles = useCallback(() => {
    setState((prev) => {
      const cur = prev.panel;
      const next: PanelMode =
        cur === "files"
          ? "none"
          : cur === "both"
            ? "term"
            : cur === "term"
              ? "both"
              : "files";
      const updated = { ...prev, panel: next };
      persist(updated);
      return updated;
    });
  }, []);

  const togglePanelTerm = useCallback(() => {
    setState((prev) => {
      const cur = prev.panel;
      const next: PanelMode =
        cur === "term"
          ? "none"
          : cur === "both"
            ? "files"
            : cur === "files"
              ? "both"
              : "term";
      const updated = { ...prev, panel: next };
      persist(updated);
      return updated;
    });
  }, []);

  return useMemo(
    () => ({
      panel: state.panel,
      runtimeWidth: clampWidth(
        state.runtimeWidth + (sidebarCollapsed ? SIDEBAR_COLLAPSE_BONUS : 0),
      ),
      ratios: state.ratios,
      setPanel,
      setRuntimeWidth,
      setRatio,
      togglePanelFiles,
      togglePanelTerm,
    }),
    [
      state.panel,
      state.runtimeWidth,
      state.ratios,
      sidebarCollapsed,
      setPanel,
      setRuntimeWidth,
      setRatio,
      togglePanelFiles,
      togglePanelTerm,
    ],
  );
}
