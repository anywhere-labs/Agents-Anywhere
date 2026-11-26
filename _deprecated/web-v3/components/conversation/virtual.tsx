"use client"

// Bounded memory for long threads, shared by the web app and the renderer (see README › 性能):
//   - a turn far from the viewport is drawn as an empty block of its last measured height (its DOM is released), and
//     drawn again when it comes near;
//   - the store keeps a window of items (store.trimHead): far above the reader, whole turns are let go and come back as
//     older pages (`loadOlder`), as the protocol's "the snapshot is the last ~100 items" already implies;
//   - under memory pressure (host message `memoryPressure`) both get tighter.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type * as React from 'react'
import type { TimelineStore } from '@/lib/timeline/store'
import { WINDOW } from '@/lib/timeline/store'
import { clearDiffMemo } from './diff'

export type PressureLevel = 'normal' | 'warning' | 'critical'

/** How far from the viewport a turn keeps its DOM, in viewport heights, by memory level. */
const NEAR = { normal: 1.5, warning: 0.5, critical: 0.1 } as const

/** What is remembered about turns no longer drawn: their heights, and step groups opened by hand. */
export const threadMemory = {
  level: 'normal' as PressureLevel,
  heights: new Map<string, number>(),
  opened: new Map<string, boolean>(),
  listeners: new Set<() => void>(),
  setLevel(level: PressureLevel) {
    this.level = level
    for (const fn of this.listeners) fn()
  },
}

/** The element that scrolls the thread (the web's Message Scroller viewport); null: the document (the renderer). */
export const ScrollRootContext = createContext<() => Element | null>(() => null)

type Watch = (near: boolean, height: number) => void

/** One IntersectionObserver per scroll root and level, shared by every turn. */
const observers = new Map<string, { io: IntersectionObserver; watchers: Map<Element, Watch> }>()
const roots = new WeakMap<Element, number>()
let rootIds = 0

function observerFor(root: Element | null, level: PressureLevel) {
  const rootKey = root ? (roots.get(root) ?? (roots.set(root, ++rootIds), rootIds)) : 0
  const key = `${rootKey}:${level}`
  let o = observers.get(key)
  if (!o) {
    const watchers = new Map<Element, Watch>()
    const m = `${Math.round(NEAR[level] * 100)}%`
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) watchers.get(e.target)?.(e.isIntersecting, e.boundingClientRect.height)
      },
      { root, rootMargin: `${m} 0px ${m} 0px` },
    )
    o = { io, watchers }
    observers.set(key, o)
  }
  return o
}

function useLevel() {
  const [level, setLevel] = useState(threadMemory.level)
  useEffect(() => {
    const fn = () => setLevel(threadMemory.level)
    threadMemory.listeners.add(fn)
    return () => void threadMemory.listeners.delete(fn)
  }, [])
  return level
}

/**
 * A turn that keeps its DOM only while it is near the viewport. `pinned` turns are always drawn (the live one, one
 * waiting for an answer). `estimate`: the height of a turn never drawn yet. The wrapper carries `data-turn-seq` for
 * the window (trimWindow).
 */
export function LazyTurn({ id, firstSeq, pinned, initiallyNear, estimate, children }: { id: string; firstSeq: number; pinned: boolean; initiallyNear: boolean; estimate: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const getRoot = useContext(ScrollRootContext)
  const level = useLevel()
  const [near, setNear] = useState(initiallyNear)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const o = observerFor(getRoot(), level)
    o.watchers.set(el, (isNear, height) => {
      if (!isNear && height > 0) threadMemory.heights.set(id, height)
      setNear(isNear)
    })
    o.io.observe(el)
    return () => {
      o.io.unobserve(el)
      o.watchers.delete(el)
    }
  }, [id, getRoot, level])
  // Let go of the turn (the window moved past it): forget its height too.
  useEffect(() => () => void threadMemory.heights.delete(id), [id])
  const drawn = pinned || near
  // The height it is drawn at, for when it is let go (a turn unpinned off screen has no observer callback first).
  useLayoutEffect(() => {
    if (drawn && ref.current) threadMemory.heights.set(id, ref.current.offsetHeight)
  })
  return (
    <div ref={ref} data-turn-seq={firstSeq} style={drawn ? undefined : { height: threadMemory.heights.get(id) ?? estimate }}>
      {drawn ? children : null}
    </div>
  )
}

/**
 * Let go of whole turns far above the reader so the store keeps about `WINDOW[level]` items. The reader's place is
 * kept: nothing at or below the first turn within one viewport height above the viewport is touched, and the views
 * hold their scroll position when content above them goes (the renderer's keepPlace, the browser's scroll anchoring).
 */
export function trimWindow(store: TimelineStore, root: Element | null) {
  const s = store.get()
  const limit = WINDOW[threadMemory.level]
  if (s.messages.length <= limit || s.loadingOlder) return
  const box = root ? root.getBoundingClientRect() : { top: 0, height: window.innerHeight }
  const scope = root ?? document
  let protectedSeq: number | undefined
  for (const el of scope.querySelectorAll<HTMLElement>('[data-turn-seq]')) {
    if (el.getBoundingClientRect().bottom > box.top - box.height) {
      protectedSeq = Number(el.dataset.turnSeq)
      break
    }
  }
  store.trimHead(limit, protectedSeq)
}

function atEnd(root: Element | null) {
  const el = root ?? document.scrollingElement ?? document.documentElement
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 24
}

/**
 * Keep the window while the thread is shown: about once a second, but only while the reader is at the end. Someone
 * reading back through history keeps every page they loaded (each would otherwise be let go again as they scroll up to
 * it); only their DOM is bounded then (LazyTurn). Memory pressure trims at once, wherever the reader is.
 */
export function useWindowTrimmer(store: TimelineStore, getRoot: () => Element | null) {
  useEffect(() => {
    const t = setInterval(() => {
      const root = getRoot()
      if (atEnd(root)) trimWindow(store, root)
    }, 1000)
    const onLevel = () => trimWindow(store, getRoot())
    threadMemory.listeners.add(onLevel)
    return () => {
      clearInterval(t)
      threadMemory.listeners.delete(onLevel)
    }
  }, [store, getRoot])
}

/** The host's `memoryPressure`: tighter from now on, and let go of what is off screen now. */
export function memoryPressure(level: 'warning' | 'critical') {
  const next = level === 'critical' || threadMemory.level === 'critical' ? 'critical' : 'warning'
  clearDiffMemo()
  threadMemory.setLevel(next)
}
