let queue: Promise<unknown> = Promise.resolve()
let sequence = 0

export function renderMermaid(code: string, dark: boolean): Promise<string> {
  // Mermaid configuration is global, so keep theme selection and rendering
  // together even when several messages render concurrently.
  const result = queue.then(async () => {
    const { default: mermaid } = await import("mermaid")
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
      fontFamily: "Arial, sans-serif",
      flowchart: { htmlLabels: false },
      suppressErrorRendering: true,
    })
    await mermaid.parse(code)
    const container = document.createElement("div")
    container.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden"
    document.body.appendChild(container)
    try {
      const { svg } = await mermaid.render(`markdown-mermaid-${++sequence}`, code, container)
      // Give the image intrinsic dimensions; percentage-only SVG dimensions
      // otherwise fall back to the browser's 300 x 150 image box.
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml")
      const root = doc.documentElement
      const viewBox = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number)
      if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
        root.setAttribute("width", String(viewBox[2]))
        root.setAttribute("height", String(viewBox[3]))
      }
      // An image isolates diagram markup and CSS from the conversation DOM.
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`
    } finally {
      container.remove()
    }
  })
  queue = result.catch(() => undefined)
  return result
}
