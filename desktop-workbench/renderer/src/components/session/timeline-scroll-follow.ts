const BOTTOM_TOLERANCE = 4

/** Owns automatic scrolling; a user's upward gesture always takes precedence. */
export function createTimelineScrollFollow(
  viewport: HTMLDivElement,
  content: HTMLDivElement,
  onPositionChange: () => void,
  onPause: () => void,
) {
  const view = viewport.ownerDocument.defaultView!
  const root = viewport.parentElement ?? viewport
  let following = true
  let disposed = false
  let frame: number | null = null
  let lastTop = viewport.scrollTop
  let direction = 0
  let touchY: number | null = null
  let draggingScrollbar = false

  const atBottom = () => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= BOTTOM_TOLERANCE
  const cancelFrame = () => {
    if (frame !== null) view.cancelAnimationFrame(frame)
    frame = null
  }

  function scrollNow(behavior: ScrollBehavior = "instant") {
    if (disposed || !following) return
    cancelFrame()
    viewport.scrollTo({ top: viewport.scrollHeight, behavior })
    lastTop = viewport.scrollTop
    onPositionChange()
  }

  function schedule() {
    if (disposed) return
    onPositionChange()
    if (!following || frame !== null) return
    frame = view.requestAnimationFrame(() => {
      frame = null
      // Input can arrive after layout changes but before this frame executes.
      if (!disposed && following) scrollNow()
    })
  }

  function pause() {
    if (disposed || !following) return
    following = false
    cancelFrame()
    // Also stop a smooth scroll started by the explicit "to bottom" button.
    viewport.scrollTo({ top: viewport.scrollTop, behavior: "instant" })
    lastTop = viewport.scrollTop
    onPause()
    onPositionChange()
  }

  function resume(behavior: ScrollBehavior = "instant") {
    if (disposed) return
    following = true
    direction = 0
    scrollNow(behavior)
  }

  function userDirection(next: number) {
    if (next === 0) return
    direction = next
    if (next < 0) pause()
    else if (!following && atBottom()) resume()
  }

  const handleWheel = (event: WheelEvent) => {
    if (!event.ctrlKey) userDirection(Math.sign(event.deltaY))
  }
  const handleTouchStart = (event: TouchEvent) => {
    touchY = event.touches[0]?.clientY ?? null
  }
  const handleTouchMove = (event: TouchEvent) => {
    const nextY = event.touches[0]?.clientY
    if (nextY !== undefined && touchY !== null) userDirection(Math.sign(touchY - nextY))
    touchY = nextY ?? null
  }
  const handleKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null
    if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) userDirection(-1)
    else if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) userDirection(1)
  }
  const handlePointerDown = (event: PointerEvent) => {
    const target = event.target as HTMLElement | null
    // Radix's scrollbar is a sibling of the viewport, so listen on the root.
    if (target?.closest('[data-slot="scroll-area-scrollbar"]')) {
      draggingScrollbar = true
      direction = 0
      pause()
    }
  }
  const handlePointerUp = () => {
    if (!draggingScrollbar) return
    draggingScrollbar = false
    if (atBottom()) resume()
  }
  const handleScroll = () => {
    const top = viewport.scrollTop
    if (top < lastTop - 0.5 && !atBottom()) pause()
    else if (!following && !draggingScrollbar && direction > 0 && top > lastTop && atBottom()) resume()
    lastTop = viewport.scrollTop
    onPositionChange()
  }

  const observer = new ResizeObserver(schedule)
  observer.observe(content)
  observer.observe(viewport)
  viewport.addEventListener("wheel", handleWheel, { passive: true, capture: true })
  viewport.addEventListener("touchstart", handleTouchStart, { passive: true })
  viewport.addEventListener("touchmove", handleTouchMove, { passive: true, capture: true })
  viewport.addEventListener("keydown", handleKeyDown, true)
  viewport.addEventListener("scroll", handleScroll, { passive: true })
  root.addEventListener("pointerdown", handlePointerDown, true)
  viewport.ownerDocument.addEventListener("pointerup", handlePointerUp)
  viewport.ownerDocument.addEventListener("pointercancel", handlePointerUp)

  return {
    isFollowing: () => following && !disposed,
    schedule,
    scrollNow,
    resume,
    pause,
    dispose() {
      disposed = true
      cancelFrame()
      observer.disconnect()
      viewport.removeEventListener("wheel", handleWheel, true)
      viewport.removeEventListener("touchstart", handleTouchStart)
      viewport.removeEventListener("touchmove", handleTouchMove, true)
      viewport.removeEventListener("keydown", handleKeyDown, true)
      viewport.removeEventListener("scroll", handleScroll)
      root.removeEventListener("pointerdown", handlePointerDown, true)
      viewport.ownerDocument.removeEventListener("pointerup", handlePointerUp)
      viewport.ownerDocument.removeEventListener("pointercancel", handlePointerUp)
    },
  }
}
