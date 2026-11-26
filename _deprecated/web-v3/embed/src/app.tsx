"use client"

import { Component, useEffect, useLayoutEffect, useSyncExternalStore, type CSSProperties, type ReactNode } from "react"
import { Toaster } from "sonner"

import { setLocale } from "@/components/i18n-provider"
import { TooltipProvider } from "@/components/ui/tooltip"

import type { Appearance, EmbedController } from "./controller"
import { ConversationView } from "./conversation-view"
import { STRINGS } from "./strings"
import { TerminalScreen } from "./terminal-screen"

/** `theme` → the document: light / dark class, safe-area variables, root font size, motion and contrast flags. */
function useAppearance(a: Appearance) {
  useLayoutEffect(() => {
    const html = document.documentElement
    html.classList.toggle("dark", a.scheme === "dark")
    html.style.colorScheme = a.scheme
    html.style.setProperty("--aa-inset-top", `${a.insets.top}px`)
    html.style.setProperty("--aa-inset-bottom", `${a.insets.bottom}px`)
    html.style.setProperty("--aa-inset-left", `${a.insets.left}px`)
    html.style.setProperty("--aa-inset-right", `${a.insets.right}px`)
    // Read by the thread's height estimates (thread.tsx): the root size is set inline.
    html.style.fontSize = `${16 * a.fontScale}px`
    html.toggleAttribute("data-reduce-motion", a.reduceMotion)
    html.toggleAttribute("data-high-contrast", a.highContrast)
  }, [a])
}

export function App({ controller }: { controller: EmbedController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const { view, appearance, locale } = state
  const strings = STRINGS[locale]
  useAppearance(appearance)
  useEffect(() => {
    document.documentElement.lang = locale
    // The terminal's words come from the web app's i18n (components/i18n-provider).
    setLocale(locale)
  }, [locale])
  useEffect(() => {
    document.documentElement.dataset.view = view.kind
  }, [view.kind])

  return (
    <TooltipProvider>
      <ErrorBoundary key={view.kind === "conversation" ? view.session_id : view.kind === "terminal" ? `t${view.nonce}` : "none"}>
        {view.kind === "conversation" ? (
          <main
            className="min-h-dvh"
            style={{
              paddingTop: "calc(var(--aa-inset-top) + 0.75rem)",
              paddingBottom: "calc(var(--aa-inset-bottom) + 1rem)",
              paddingLeft: "calc(var(--aa-inset-left) + 1rem)",
              paddingRight: "calc(var(--aa-inset-right) + 1rem)",
            }}
          >
            <ConversationView key={view.session_id} controller={controller} view={view} appearance={appearance} strings={strings} />
          </main>
        ) : view.kind === "terminal" ? (
          <TerminalScreen controller={controller} view={view} />
        ) : (
          <p className="flex min-h-dvh items-center justify-center px-6 text-center text-sm text-muted-foreground">{strings.waiting}</p>
        )}
      </ErrorBoundary>
      <Toaster
        theme={appearance.scheme}
        position="top-center"
        offset={{ top: appearance.insets.top + 8 }}
        mobileOffset={{ top: appearance.insets.top + 8 }}
        style={
          {
            "--normal-bg": "var(--popover)",
            "--normal-text": "var(--popover-foreground)",
            "--normal-border": "var(--border)",
          } as CSSProperties
        }
      />
    </TooltipProvider>
  )
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error("[aa.render] render failed", error)
  }

  render() {
    if (this.state.error)
      return (
        <pre className="m-4 rounded-xl bg-muted p-3 text-xs whitespace-pre-wrap text-destructive" style={{ marginTop: "calc(var(--aa-inset-top) + 1rem)" }}>
          {String(this.state.error.stack ?? this.state.error.message)}
        </pre>
      )
    return this.props.children
  }
}
