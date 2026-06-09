import { useCallback, useRef, type ReactNode } from "react";
import {
  RATIO_MAX,
  RATIO_MIN,
  RUNTIME_MAX_W,
  RUNTIME_MIN_W,
  type PaneRatios,
  type PanelMode,
} from "./useRuntimeLayout";
import { useResizeGrip } from "./useResizeGrip";

export type RuntimePanelProps = {
  panel: PanelMode;
  setPanel: (panel: PanelMode) => void;
  filesEl: ReactNode | null;
  previewEl: ReactNode | null;
  termEl: ReactNode | null;
  runtimeWidth: number;
  setRuntimeWidth: (next: number) => void;
  ratios: PaneRatios;
  setRatio: (key: keyof PaneRatios, value: number) => void;
};

/**
 * Right-hand "runtime" column. Three layouts, switched by which panes
 * are visible:
 *
 *   * 1 pane     → that pane fills the column
 *   * 2 panes    → vertical stack, both panes use `flex-grow` so they
 *                  split according to `ratios.vSplit` (default 0.5 = 50/50)
 *   * 3 panes    → "three-way": files + term stacked left, preview right.
 *                  - left column width vs preview width = ratios.hSplit
 *                  - inside left column: files vs term height = ratios.innerVSplit
 *
 * Resize state:
 *   - column width is in px (state.runtimeWidth) — clamped 280–1100
 *   - all internal splits are ratios 0–1 — clamped 0.12–0.88
 *
 * Mouse-anchoring fix: see useResizeGrip — the snapshot is captured
 * **once** at mousedown and held for the whole drag, so the grip stays
 * locked to the cursor instead of drifting with React renders.
 */
export function RuntimePanel(props: RuntimePanelProps) {
  const {
    filesEl,
    previewEl,
    termEl,
    runtimeWidth,
    setRuntimeWidth,
    ratios,
    setRatio,
  } = props;

  const hasFiles = filesEl !== null;
  const hasTerm = termEl !== null;
  const hasPreview = previewEl !== null;
  if (!hasFiles && !hasTerm && !hasPreview) return null;

  // Refs we read at mousedown to compute ratios from px deltas.
  const runtimeRef = useRef<HTMLDivElement | null>(null);
  const verticalStackRef = useRef<HTMLDivElement | null>(null);
  const leftColRef = useRef<HTMLDivElement | null>(null);

  // ── Outer column resize ─────────────────────────────────────────────
  const widthGripGetStart = useCallback(() => runtimeWidth, [runtimeWidth]);
  const widthGripOnDrag = useCallback(
    (start: number, dx: number) => {
      // Grip sits on the left edge — dragging right (positive dx) makes
      // the runtime narrower; dragging left (negative dx) widens it.
      const next = Math.max(RUNTIME_MIN_W, Math.min(RUNTIME_MAX_W, start - dx));
      setRuntimeWidth(next);
    },
    [setRuntimeWidth],
  );
  const onColResize = useResizeGrip({
    axis: "x",
    getStart: widthGripGetStart,
    onDrag: widthGripOnDrag,
  });

  // ── Three-way horizontal split (left column vs preview) ─────────────
  const hSplitGetStart = useCallback(() => ratios.hSplit, [ratios.hSplit]);
  const hSplitOnDrag = useCallback(
    (start: number, dx: number) => {
      const el = runtimeRef.current;
      if (!el) return;
      const width = el.getBoundingClientRect().width;
      if (width <= 0) return;
      const next = clamp(start + dx / width, RATIO_MIN, RATIO_MAX);
      setRatio("hSplit", next);
    },
    [setRatio],
  );
  const onHSplitResize = useResizeGrip({
    axis: "x",
    getStart: hSplitGetStart,
    onDrag: hSplitOnDrag,
  });

  // ── Vertical split (top vs bottom pane) ─────────────────────────────
  const vSplitGetStart = useCallback(() => ratios.vSplit, [ratios.vSplit]);
  const vSplitOnDrag = useCallback(
    (start: number, dy: number) => {
      const el = verticalStackRef.current;
      if (!el) return;
      const height = el.getBoundingClientRect().height;
      if (height <= 0) return;
      const next = clamp(start + dy / height, RATIO_MIN, RATIO_MAX);
      setRatio("vSplit", next);
    },
    [setRatio],
  );
  const onVSplitResize = useResizeGrip({
    axis: "y",
    getStart: vSplitGetStart,
    onDrag: vSplitOnDrag,
  });

  // ── Inner vertical split inside three-way's left column ─────────────
  const innerVGetStart = useCallback(
    () => ratios.innerVSplit,
    [ratios.innerVSplit],
  );
  const innerVOnDrag = useCallback(
    (start: number, dy: number) => {
      const el = leftColRef.current;
      if (!el) return;
      const height = el.getBoundingClientRect().height;
      if (height <= 0) return;
      const next = clamp(start + dy / height, RATIO_MIN, RATIO_MAX);
      setRatio("innerVSplit", next);
    },
    [setRatio],
  );
  const onInnerVResize = useResizeGrip({
    axis: "y",
    getStart: innerVGetStart,
    onDrag: innerVOnDrag,
  });

  // ── Three-way layout (files + term stacked left, preview right) ────
  if (hasFiles && hasTerm && hasPreview) {
    return (
      <div className="kl-rt-shell" style={{ width: runtimeWidth }}>
        <div className="kl-h-grip" onMouseDown={onColResize} />
        <div className="kl-runtime three-way" ref={runtimeRef}>
          <div
            className="kl-runtime-left"
            ref={leftColRef}
            style={{ flex: `${ratios.hSplit} 1 0`, minWidth: 0 }}
          >
            <div
              className="kl-rt-pane-host"
              style={{ flex: `${ratios.innerVSplit} 1 0` }}
            >
              {filesEl}
            </div>
            <div className="kl-rt-grip" onMouseDown={onInnerVResize} />
            <div
              className="kl-rt-pane-host"
              style={{ flex: `${1 - ratios.innerVSplit} 1 0` }}
            >
              {termEl}
            </div>
          </div>
          <div className="kl-h-grip-inner" onMouseDown={onHSplitResize} />
          <div
            className="kl-rt-pane-host"
            style={{ flex: `${1 - ratios.hSplit} 1 0`, minWidth: 0 }}
          >
            {previewEl}
          </div>
        </div>
      </div>
    );
  }

  // ── Vertical stack (1 or 2 panes) ───────────────────────────────────
  const panes: { key: string; el: ReactNode }[] = [];
  if (hasFiles && filesEl) panes.push({ key: "files", el: filesEl });
  if (hasPreview && previewEl) panes.push({ key: "preview", el: previewEl });
  if (hasTerm && termEl) panes.push({ key: "term", el: termEl });

  return (
    <div className="kl-rt-shell" style={{ width: runtimeWidth }}>
      <div className="kl-h-grip" onMouseDown={onColResize} />
      <div className="kl-runtime" ref={verticalStackRef}>
        {panes.length === 1 && (
          <div
            className="kl-rt-pane-host"
            key={panes[0].key}
            style={{ flex: "1 1 0" }}
          >
            {panes[0].el}
          </div>
        )}
        {panes.length === 2 && (
          <>
            <div
              className="kl-rt-pane-host"
              key={panes[0].key}
              style={{ flex: `${ratios.vSplit} 1 0` }}
            >
              {panes[0].el}
            </div>
            <div className="kl-rt-grip" onMouseDown={onVSplitResize} />
            <div
              className="kl-rt-pane-host"
              key={panes[1].key}
              style={{ flex: `${1 - ratios.vSplit} 1 0` }}
            >
              {panes[1].el}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
