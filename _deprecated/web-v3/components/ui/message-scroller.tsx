"use client"

import * as React from "react"
import { ArrowDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface ScrollerCtx {
  atEnd: boolean
  scrollable: boolean
  scrollToEnd: (smooth?: boolean) => void
  scrollToStart: (smooth?: boolean) => void
  onContentMutated: () => void
  registerViewport: (node: HTMLDivElement | null) => void
  onViewportScroll: (el: HTMLDivElement) => void
}

const MessageScrollerContext = React.createContext<ScrollerCtx | null>(null)

export function useMessageScroller() {
  const ctx = React.useContext(MessageScrollerContext)
  if (!ctx) throw new Error("useMessageScroller must be used inside MessageScroller")
  return {
    atEnd: ctx.atEnd,
    scrollToEnd: ctx.scrollToEnd,
    scrollToStart: ctx.scrollToStart,
  }
}

export function useMessageScrollerScrollable() {
  return React.useContext(MessageScrollerContext)?.scrollable ?? false
}

export function useMessageScrollerVisibility() {
  const ctx = React.useContext(MessageScrollerContext)
  return { atEnd: ctx?.atEnd ?? true }
}

function MessageScrollerProvider({ children }: { children: React.ReactNode }) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null)
  const stickToEndRef = React.useRef(true)
  const [atEnd, setAtEnd] = React.useState(true)
  const [scrollable, setScrollable] = React.useState(false)

  const registerViewport = React.useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node
  }, [])

  const onViewportScroll = React.useCallback((el: HTMLDivElement) => {
    const nearEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= 48
    stickToEndRef.current = nearEnd
    setAtEnd(nearEnd)
    setScrollable(el.scrollHeight - el.clientHeight > 24)
  }, [])

  const scrollToEnd = React.useCallback((smooth = true) => {
    const el = viewportRef.current
    if (!el) return
    stickToEndRef.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" })
    setAtEnd(true)
  }, [])

  const scrollToStart = React.useCallback((smooth = true) => {
    const el = viewportRef.current
    if (!el) return
    stickToEndRef.current = false
    el.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" })
  }, [])

  const onContentMutated = React.useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    const isScrollable = el.scrollHeight - el.clientHeight > 24
    setScrollable(isScrollable)
    if (stickToEndRef.current) {
      el.scrollTop = el.scrollHeight
      setAtEnd(true)
    } else {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight <= 48
      setAtEnd(near)
    }
  }, [])

  const value = React.useMemo<ScrollerCtx>(
    () => ({
      atEnd,
      scrollable,
      scrollToEnd,
      scrollToStart,
      onContentMutated,
      registerViewport,
      onViewportScroll,
    }),
    [atEnd, scrollable, scrollToEnd, scrollToStart, onContentMutated, registerViewport, onViewportScroll]
  )

  return (
    <MessageScrollerContext.Provider value={value}>
      {children}
    </MessageScrollerContext.Provider>
  )
}

function MessageScroller({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const existing = React.useContext(MessageScrollerContext)
  const inner = (
    <div
      data-slot="message-scroller"
      className={cn(
        "group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
  return existing ? inner : <MessageScrollerProvider>{inner}</MessageScrollerProvider>
}

function MessageScrollerViewport({
  className,
  onScroll,
  ref,
  ...props
}: React.ComponentProps<"div">) {
  const ctx = React.useContext(MessageScrollerContext)

  const setRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      ctx?.registerViewport(node)
      if (typeof ref === "function") ref(node)
      else if (ref && "current" in ref) {
        ;(ref as React.MutableRefObject<HTMLDivElement | null>).current = node
      }
    },
    [ctx, ref]
  )

  const handleScroll = React.useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      ctx?.onViewportScroll(e.currentTarget)
      onScroll?.(e)
    },
    [ctx, onScroll]
  )

  return (
    <div
      ref={setRef}
      data-slot="message-scroller-viewport"
      onScroll={handleScroll}
      className={cn(
        "size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerContent({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const ctx = React.useContext(MessageScrollerContext)
  const contentRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const el = contentRef.current
    if (!el || !ctx || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => {
      ctx.onContentMutated()
    })
    ro.observe(el)
    ctx.onContentMutated()
    return () => ro.disconnect()
  }, [ctx])

  return (
    <div
      ref={contentRef}
      data-slot="message-scroller-content"
      className={cn("flex h-max min-h-full flex-col gap-6", className)}
      {...props}
    >
      {children}
    </div>
  )
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<"div"> & { scrollAnchor?: boolean }) {
  return (
    <div
      data-slot="message-scroller-item"
      data-scroll-anchor={scrollAnchor ? "true" : undefined}
      className={cn("min-w-0 shrink-0", className)}
      {...props}
    />
  )
}

function MessageScrollerButton({
  direction = "end",
  className,
  children,
  variant = "secondary",
  size = "icon-sm",
  onClick,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "children"> & {
  direction?: "start" | "end"
  children?: React.ReactNode
}) {
  const ctx = React.useContext(MessageScrollerContext)
  const active = direction === "end" ? Boolean(ctx && ctx.scrollable && !ctx.atEnd) : false

  return (
    <Button
      type="button"
      data-slot="message-scroller-button"
      data-direction={direction}
      data-active={active ? "true" : "false"}
      variant={variant}
      size={size}
      className={cn(
        "absolute left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-popover text-foreground shadow-sm transition-all duration-200 hover:bg-muted",
        direction === "end" ? "bottom-4" : "top-4 [&_svg]:rotate-180",
        active
          ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
          : "pointer-events-none translate-y-2 scale-95 opacity-0",
        className
      )}
      onClick={(e) => {
        if (direction === "end") ctx?.scrollToEnd(true)
        else ctx?.scrollToStart(true)
        onClick?.(e)
      }}
      {...props}
    >
      {children ?? (
        <>
          <ArrowDownIcon className="size-4" />
          <span className="sr-only">
            {direction === "end" ? "Scroll to end" : "Scroll to start"}
          </span>
        </>
      )}
    </Button>
  )
}

export {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
}
