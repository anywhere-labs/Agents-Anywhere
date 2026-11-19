// Message Scroller's behaviour, for a thread that scrolls the document instead of an inner overflow box. On iOS the
// WKWebView's own UIScrollView has to be the one scrolling: tap-to-top on the status bar, rubber-banding and the native
// glass scroll-edge effect only work for it. The stock MessageScroller (@shadcn/react) measures and scrolls an element
// viewport, so this re-implements the parts the renderer needs against `window`:
//   - opens at the end, hidden until the layout has settled there (no visible jump)
//   - follows the end while the reader is at it (streaming), and lets go when the reader scrolls away
//   - keeps the reader's place when older items are prepended or content above changes size
//   - a new turn from the person goes back to the end
//   - reports { atEnd, atTop } (debounced) so native can draw its own "到底部" button, and asks for older items near
//     the top once the reader has scrolled
//   - "到底部" (scrollToEnd) keeps going until it is at the end, however fast the end moves, or the reader takes over
// Nothing here walks the whole thread: the reader's place is found by bisecting the items, and size changes are
// handled at most once a frame.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type * as React from 'react'
import { surroundings } from './surroundings'

const END_SLOP = 24
const LOAD_OLDER_WITHIN = 400
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

export interface DocumentScrollerOptions {
  /** Bumped on every snapshot: open at the end again. */
  epoch: number
  /** The first and last item keys, and whether the last one is the person's turn. */
  firstKey?: string
  lastKey?: string
  lastIsAnchor: boolean
  canLoadOlder: boolean
  onLoadOlder: () => void
  onScrollState: (s: { atEnd: boolean; atTop: boolean }) => void
  reduceMotion: boolean
}

/** Set by the mounted scroller; `scrollToEnd` from the host goes here. */
export const documentScroll = { scrollToEnd: (_animated: boolean) => {} }

const root = () => document.documentElement
const maxScroll = () => Math.max(0, root().scrollHeight - root().clientHeight)

export function useDocumentScroller(o: DocumentScrollerOptions) {
  const content = useRef<HTMLDivElement>(null)
  const opts = useRef(o)
  opts.current = o
  const following = useRef(true)
  const touching = useRef(false)
  const intentAt = useRef(-Infinity) // not 0: performance.now() is small right after load, which read as "the reader just scrolled"
  const readerScrolled = useRef(false)
  const lastChange = useRef(0)
  const anchor = useRef<{ el: Element; top: number } | null>(null)
  const reported = useRef('')
  const reportTimer = useRef(0)
  const [settled, setSettled] = useState(false)
  const settledRef = useRef(false)
  const chase = useRef(0)

  const toEnd = useCallback((smooth = false) => {
    window.scrollTo({ top: maxScroll(), behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  /** The first item still visible below the top inset, and where it is: what "the reader's place" means. */
  const saveAnchor = useCallback(() => {
    const c = content.current
    anchor.current = null
    if (!c) return
    const top = surroundings.get().viewport.top
    // The items are stacked top to bottom: bisect for the first one whose bottom is below the top inset.
    const items = c.children
    let lo = 0
    let hi = items.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (items[mid].getBoundingClientRect().bottom > top) hi = mid
      else lo = mid + 1
    }
    const el = items[lo]
    if (el) anchor.current = { el, top: el.getBoundingClientRect().top }
  }, [])

  const keepPlace = useCallback(() => {
    const a = anchor.current
    if (a?.el.isConnected) {
      const d = a.el.getBoundingClientRect().top - a.top
      if (Math.abs(d) > 0.5) window.scrollBy(0, d)
    }
    saveAnchor()
  }, [saveAnchor])

  const report = useCallback(() => {
    window.clearTimeout(reportTimer.current)
    reportTimer.current = window.setTimeout(() => {
      if (!settledRef.current) return
      const s = { atEnd: maxScroll() - window.scrollY <= END_SLOP, atTop: window.scrollY <= 4 }
      const key = `${s.atEnd}${s.atTop}`
      if (key === reported.current) return
      reported.current = key
      opts.current.onScrollState(s)
    }, 100)
  }, [])

  // ResizeObserver runs after layout and before paint, so correcting here does not show a frame at the wrong place;
  // the window's resize and the observer landing in the same frame are handled once.
  const handled = useRef(false)
  const onResize = useCallback((always?: unknown) => {
    lastChange.current = performance.now()
    if (handled.current && always !== true) return
    handled.current = true
    requestAnimationFrame(() => (handled.current = false))
    if (chase.current) return // "到底部" in progress: it aims at the new end on its next frame
    if (following.current) toEnd()
    else keepPlace()
    report()
  }, [toEnd, keepPlace, report])

  // Size changes anywhere: items growing while they stream, images loading, folds opening, the insets changing.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => onResize())
    ro.observe(document.body, { box: 'border-box' })
    if (content.current) ro.observe(content.current)
    const onWindow = () => onResize(true)
    window.addEventListener('resize', onWindow)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWindow)
    }
  }, [onResize])

  // The reader's hand: touch, wheel, keys. Scroll events alone cannot tell the reader from our own scrollTo.
  useEffect(() => {
    const intent = () => {
      intentAt.current = performance.now()
    }
    const down = () => {
      touching.current = true
      intent()
    }
    const up = () => {
      touching.current = false
      intent()
    }
    const key = (e: KeyboardEvent) => SCROLL_KEYS.has(e.key) && intent()
    const scroll = () => {
      const atEnd = maxScroll() - window.scrollY <= END_SLOP
      const byReader = touching.current || performance.now() - intentAt.current < 600
      if (atEnd) following.current = true
      else if (byReader) following.current = false
      if (byReader && settledRef.current) readerScrolled.current = true
      saveAnchor()
      report()
      const { canLoadOlder, onLoadOlder } = opts.current
      if (readerScrolled.current && canLoadOlder && window.scrollY < LOAD_OLDER_WITHIN) onLoadOlder()
    }
    window.addEventListener('scroll', scroll, { passive: true })
    window.addEventListener('touchstart', down, { passive: true })
    window.addEventListener('touchmove', intent, { passive: true })
    window.addEventListener('touchend', up, { passive: true })
    window.addEventListener('touchcancel', up, { passive: true })
    window.addEventListener('wheel', intent, { passive: true })
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('scroll', scroll)
      window.removeEventListener('touchstart', down)
      window.removeEventListener('touchmove', intent)
      window.removeEventListener('touchend', up)
      window.removeEventListener('touchcancel', up)
      window.removeEventListener('wheel', intent)
      window.removeEventListener('keydown', key)
    }
  }, [saveAnchor, report])

  // A snapshot (a session opened, or the stream restarted): open at the end, hidden until it stops moving.
  useLayoutEffect(() => {
    following.current = true
    readerScrolled.current = false
    settledRef.current = false
    reported.current = ''
    setSettled(false)
    toEnd()
    const start = performance.now()
    lastChange.current = start
    let frame = 0
    const tick = () => {
      const now = performance.now()
      if (now - lastChange.current > 50 || now - start > 600) {
        toEnd()
        settledRef.current = true
        setSettled(true)
        saveAnchor()
        report()
      } else frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [o.epoch, toEnd, saveAnchor, report])

  // Older items arrived on top: put the reader back where they were, before the frame paints.
  const prevFirst = useRef(o.firstKey)
  useLayoutEffect(() => {
    if (prevFirst.current !== o.firstKey && !following.current) keepPlace()
    prevFirst.current = o.firstKey
  }, [o.firstKey, keepPlace])

  // The person sent something (here or from native): back to the end, following.
  const prevLast = useRef(o.lastKey)
  useLayoutEffect(() => {
    if (prevLast.current !== o.lastKey && o.lastIsAnchor && settledRef.current) {
      following.current = true
      toEnd()
    }
    prevLast.current = o.lastKey
  }, [o.lastKey, o.lastIsAnchor, toEnd])

  // "到底部": aim at the end every frame until there (two frames in a row: the last items may still be drawn and grow),
  // or until the reader scrolls. A far end is jumped to first, so the turns in between are not all drawn on the way.
  useEffect(() => {
    documentScroll.scrollToEnd = (animated) => {
      cancelAnimationFrame(chase.current)
      following.current = true
      const smooth = animated && !opts.current.reduceMotion
      const startedAt = performance.now()
      const vh = root().clientHeight
      if (maxScroll() - window.scrollY > 2 * vh) window.scrollTo({ top: maxScroll() - (smooth ? vh : 0), behavior: 'auto' })
      let atEndFrames = 0
      const step = () => {
        if (touching.current || intentAt.current > startedAt) {
          chase.current = 0
          return
        }
        const left = maxScroll() - window.scrollY
        if (left <= 1) {
          if (++atEndFrames >= 2) {
            chase.current = 0
            saveAnchor()
            report()
            return
          }
        } else {
          atEndFrames = 0
          // Ease out over ~10 frames; the end moving meanwhile just changes the aim.
          const by = smooth && performance.now() - startedAt < 1500 ? Math.max(Math.ceil(left * 0.22), 8) : left
          window.scrollTo({ top: Math.min(maxScroll(), window.scrollY + by), behavior: 'auto' })
        }
        chase.current = requestAnimationFrame(step)
      }
      chase.current = requestAnimationFrame(step)
    }
    return () => cancelAnimationFrame(chase.current)
  }, [saveAnchor, report])

  return { content, settled }
}

/** An item of the document-scrolled thread (the renderer's ThreadItem). */
export function DocumentItem({ id, anchor, children }: { id: string; anchor: boolean; children: React.ReactNode }) {
  return (
    <div data-message-id={id} data-scroll-anchor={anchor ? 'true' : 'false'} className="min-w-0">
      {children}
    </div>
  )
}
