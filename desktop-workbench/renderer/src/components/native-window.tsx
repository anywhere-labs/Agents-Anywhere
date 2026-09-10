"use client"

import * as React from "react"
import { createPortal } from "react-dom"

type NativeWindowProps = {
  title: string
  onClose: () => void
  children: React.ReactNode
  features?: string
}

export function NativeWindow({
  title,
  onClose,
  children,
  features = "width=980,height=720,resizable=yes,scrollbars=yes",
}: NativeWindowProps) {
  const [container, setContainer] = React.useState<HTMLElement | null>(null)
  const onCloseRef = React.useRef(onClose)

  React.useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  React.useEffect(() => {
    const child = window.open("", "_blank", features)
    if (!child) {
      onCloseRef.current()
      return
    }

    child.document.open()
    child.document.write(
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>',
    )
    child.document.close()
    child.document.title = title
    syncDocumentTheme(child)
    copyDocumentStyles(child)

    const root = child.document.createElement("div")
    root.className = "aa-native-window-root"
    child.document.body.append(root)
    setContainer(root)

    const timer = window.setInterval(() => {
      if (child.closed) {
        window.clearInterval(timer)
        onCloseRef.current()
      }
    }, 500)

    return () => {
      window.clearInterval(timer)
      if (!child.closed) child.close()
    }
  }, [features, title])

  return container ? createPortal(children, container) : null
}

function syncDocumentTheme(child: Window) {
  child.document.documentElement.className = document.documentElement.className
  child.document.documentElement.style.cssText = document.documentElement.style.cssText
  child.document.body.className = document.body.className
  child.document.body.style.cssText = document.body.style.cssText

  const observer = new MutationObserver(() => {
    if (child.closed) return
    child.document.documentElement.className = document.documentElement.className
    child.document.documentElement.style.cssText = document.documentElement.style.cssText
    child.document.body.className = document.body.className
    child.document.body.style.cssText = document.body.style.cssText
  })

  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] })
  observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] })

  child.addEventListener("beforeunload", () => observer.disconnect(), { once: true })
}

function copyDocumentStyles(child: Window) {
  for (const stylesheet of Array.from(document.styleSheets)) {
    try {
      if (stylesheet.href) {
        const link = child.document.createElement("link")
        link.rel = "stylesheet"
        link.href = stylesheet.href
        child.document.head.append(link)
        continue
      }
      const css = Array.from(stylesheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n")
      if (!css) continue
      const style = child.document.createElement("style")
      style.textContent = css
      child.document.head.append(style)
    } catch {
      // Ignore cross-origin sheets.
    }
  }

  const style = child.document.createElement("style")
  style.textContent = `
    html,
    body,
    .aa-native-window-root {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: var(--background);
      color: var(--foreground);
    }
    .aa-native-window-root {
      display: flex;
      min-width: 0;
      min-height: 0;
    }
    .aa-native-window-root > * {
      flex: 1 1 0;
      min-width: 0;
      min-height: 0;
    }
  `
  child.document.head.append(style)
}
