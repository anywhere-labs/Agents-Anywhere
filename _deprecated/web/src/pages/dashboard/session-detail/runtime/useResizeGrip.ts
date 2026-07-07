import { useCallback } from "react";

export type GripAxis = "x" | "y";

export type GripOptions<T> = {
  axis: GripAxis;
  /**
   * Called once on mousedown to snapshot the starting state. The returned
   * value is held constant for the whole drag — `onDrag` always gets this
   * same value paired with the current delta. This is the fix for the
   * previous bug where the snapshot was being re-read every React render
   * during the drag, causing the anchor to drift away from the mouse.
   */
  getStart: () => T;
  onDrag: (start: T, delta: number) => void;
  onEnd?: () => void;
};

/**
 * Returns a `onMouseDown` handler that turns the target element into a
 * drag grip. While dragging:
 *   - the body gets `.kl-resizing` so text selection is disabled
 *     site-wide
 *   - the grip itself gets `.active` so its indicator highlights
 *   - `onDrag(start, delta)` fires on every move with the snapshot from
 *     `getStart` and the cumulative px delta since mousedown
 */
export function useResizeGrip<T>(opts: GripOptions<T>) {
  const { axis, getStart, onDrag, onEnd } = opts;
  return useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const grip = e.currentTarget as HTMLElement;
      grip.classList.add("active");
      document.body.classList.add("kl-resizing");
      const start = getStart();
      const startCoord = axis === "x" ? e.clientX : e.clientY;
      const handleMove = (ev: MouseEvent) => {
        const cur = axis === "x" ? ev.clientX : ev.clientY;
        onDrag(start, cur - startCoord);
      };
      const handleUp = () => {
        grip.classList.remove("active");
        document.body.classList.remove("kl-resizing");
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        onEnd?.();
      };
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [axis, getStart, onDrag, onEnd],
  );
}
