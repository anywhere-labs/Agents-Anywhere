"use client"

// The conversation view: web-v3's own thread (components/conversation/*) in the document scroller. The page scrolls
// as a whole (no inner scroll box), so the native glass bars float over content that scrolls under them; the content
// is padded by `theme.insets`. Touches belong to the WebView (doc §4): no gesture handling beyond native scrolling.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react"
import type * as React from "react"
import { LoaderCircleIcon } from "lucide-react"

import { ThreadEnvContext, type OpenTarget, type ThreadEnv } from "@/components/conversation/env"
import { Thread, type ThreadItem } from "@/components/conversation/thread"
import { ScrollRootContext, useWindowTrimmer } from "@/components/conversation/virtual"
import { Button } from "@/components/ui/button"

import type { Appearance, EmbedController, View } from "./controller"
import { PLACEHOLDER_IMAGE } from "./file-cache"
import type { EmbedStrings } from "./strings"

type ConversationViewState = Extract<View, { kind: "conversation" }>

/** Within this many px of the end counts as "at the bottom". */
const AT_BOTTOM_PX = 24
/** Closer than this to the top asks for older items. */
const LOAD_OLDER_PX = 480

const DocumentItem: ThreadItem = ({ id, children }) => (
  <div data-turn-id={id} className="min-w-0">
    {children}
  </div>
)

const documentRoot = () => null

function scroller(): HTMLElement {
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

function distanceFromBottom() {
  const el = scroller()
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
}

export function ConversationView({
  controller,
  view,
  appearance,
  strings,
}: {
  controller: EmbedController
  view: ConversationViewState
  appearance: Appearance
  strings: EmbedStrings
}) {
  const store = controller.store
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  const files = controller.files
  const fileVersion = useSyncExternalStore(files.subscribe, files.getVersion, files.getVersion)
  const canAnswer = !view.readonly && !view.stale

  const env = useMemo<ThreadEnv>(
    () => ({
      me: view.me,
      approvals: canAnswer ? "inline" : "host",
      reduceMotion: appearance.reduceMotion,
      imageSrc: (path, mime) => files.url(path, mime) ?? PLACEHOLDER_IMAGE,
      answer: (requestId, optionId) => controller.answer(requestId, optionId),
      // A drive reference goes out as a link (`open_link` with `drive:/…`, docs/v3/mobile-bridge.md).
      open: (target: OpenTarget) =>
        target.kind === "url"
          ? controller.openLink(target.url)
          : target.kind === "drive"
            ? controller.openLink(target.ref)
            : controller.openFile(target.path, target.line),
      copy: (text) => controller.copy(text),
      haptic: (style) => controller.haptic(style),
      // Native has its own sheets: no in-page fullscreen or downloads (a WebView cannot save files).
      markdownControls: false,
    }),
    // `fileVersion`: image sources change when a file.read settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controller, files, view.me, canAnswer, appearance.reduceMotion, fileVersion]
  )

  useWindowTrimmer(store, documentRoot)
  const contentRef = useRef<HTMLDivElement>(null)
  useDocumentScroller(controller, contentRef, state.epoch, appearance)

  const empty = view.loaded && !state.messages.length && !state.outgoing.length && !state.control?.queued.length

  return (
    <ThreadEnvContext.Provider value={env}>
      <ScrollRootContext.Provider value={documentRoot}>
        {view.stale && (
          <div className="sticky z-10 mb-4 flex justify-center" style={{ top: "calc(var(--aa-inset-top) + 0.5rem)" }}>
            <p role="status" className="rounded-xl bg-banner px-3 py-1.5 text-center text-xs text-banner-foreground shadow-sm">
              {strings.stale}
            </p>
          </div>
        )}
        <div ref={contentRef} className="mx-auto flex w-full max-w-3xl flex-col gap-8" data-embed-thread="">
          {state.loadingOlder && (
            <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <LoaderCircleIcon className="size-3.5 animate-spin" />
              {strings.loadingOlder}
            </p>
          )}
          {!state.loadingOlder && state.has_more && !view.stale && state.messages.length > 0 && (
            <div className="flex justify-center">
              <Button size="xs" variant="ghost" onClick={() => controller.loadOlder()}>
                {strings.loadOlder}
              </Button>
            </div>
          )}
          {!view.loaded ? (
            <p className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" />
              {strings.loading}
            </p>
          ) : empty ? (
            <p className="py-24 text-center text-sm text-muted-foreground">{strings.empty}</p>
          ) : (
            <Thread state={state} Item={DocumentItem} />
          )}
        </div>
      </ScrollRootContext.Provider>
    </ThreadEnvContext.Provider>
  )
}

/**
 * The document scroller: follows the end while the reader is there, keeps their place otherwise (older pages
 * prepended, turns drawn at their real height, the window trimmed), asks for older items near the top, reports
 * `scroll_state` and obeys native's `scroll`.
 */
function useDocumentScroller(controller: EmbedController, contentRef: React.RefObject<HTMLDivElement | null>, epoch: number, appearance: Appearance) {
  const stick = useRef(true)
  const anchor = useRef<{ id: string; top: number } | null>(null)
  /** Until then, a smooth scroll we started is running: its intermediate positions do not unstick. */
  const smoothUntil = useRef(0)
  const insetTop = appearance.insets.top
  const reduceMotion = appearance.reduceMotion

  const captureAnchor = useCallback(() => {
    anchor.current = null
    for (const el of document.querySelectorAll<HTMLElement>("[data-turn-id]")) {
      const r = el.getBoundingClientRect()
      if (r.bottom > insetTop) {
        anchor.current = { id: el.dataset.turnId!, top: r.top }
        return
      }
    }
  }, [insetTop])

  const report = useCallback(() => {
    const d = distanceFromBottom()
    controller.reportScroll(d <= AT_BOTTOM_PX, d)
  }, [controller])

  const toBottom = useCallback((smooth: boolean) => {
    const el = scroller()
    const top = el.scrollHeight
    if (smooth) {
      smoothUntil.current = performance.now() + 700
      window.scrollTo({ top, behavior: "smooth" })
    } else window.scrollTo(0, top)
  }, [])

  /** After content changed size: stay at the end, or keep the first visible turn where it was. */
  const settle = useCallback(() => {
    if (stick.current) {
      if (distanceFromBottom() > 1 && performance.now() > smoothUntil.current) toBottom(false)
    } else if (anchor.current) {
      const el = document.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(anchor.current.id)}"]`)
      if (el) {
        const delta = el.getBoundingClientRect().top - anchor.current.top
        if (Math.abs(delta) >= 1) window.scrollBy(0, delta)
      }
    }
    captureAnchor()
    report()
    // Not enough to scroll yet but more exists: keep asking (the controller allows one request at a time).
    const el = scroller()
    if (el.scrollHeight <= el.clientHeight + LOAD_OLDER_PX) controller.loadOlder()
  }, [captureAnchor, controller, report, toBottom])

  // Every commit (a push, an older page): settle before paint.
  useLayoutEffect(() => {
    settle()
  })

  // A new snapshot (a new conversation, or a reconnect): start at the end.
  useLayoutEffect(() => {
    stick.current = true
    toBottom(false)
  }, [epoch, toBottom])

  // Turns drawn later (lazy turns, images, highlighted code) change height without a commit here.
  useEffect(() => {
    const el = contentRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => settle())
    ro.observe(el)
    return () => ro.disconnect()
  }, [contentRef, settle])

  // The reader scrolls.
  useEffect(() => {
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const d = distanceFromBottom()
        const atBottom = d <= AT_BOTTOM_PX
        if (atBottom) stick.current = true
        else if (performance.now() > smoothUntil.current) stick.current = false
        captureAnchor()
        controller.reportScroll(atBottom, d)
        if (scroller().scrollTop < LOAD_OLDER_PX) controller.loadOlder()
      })
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    // The viewport changes (rotation, insets): the end stays the end.
    window.addEventListener("resize", settle)
    return () => {
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", settle)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [captureAnchor, controller, settle])

  // Native's buttons.
  useEffect(
    () =>
      controller.onScrollRequest((r) => {
        if (r.to === "bottom") {
          stick.current = true
          toBottom(!reduceMotion)
        } else {
          stick.current = false
          window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" })
        }
      }),
    [controller, reduceMotion, toBottom]
  )
}
