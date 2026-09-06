export async function copyText(text: string, container?: HTMLElement): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // Some browsers expose the API but reject writes. Try the user-initiated fallback.
  }

  const ownerDocument = container?.ownerDocument ?? (typeof document === "undefined" ? null : document)
  if (!ownerDocument || typeof ownerDocument.execCommand !== "function") {
    throw new Error("Clipboard is unavailable")
  }

  const previousFocus = ownerDocument.activeElement as HTMLElement | null
  const selection = ownerDocument.getSelection()
  const previousRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : []
  const textarea = ownerDocument.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.tabIndex = -1
  textarea.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;"
  try {
    // Keep the selection inside the caller's modal focus boundary.
    const parent = container ?? ownerDocument.body
    parent.appendChild(textarea)
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    if (!ownerDocument.execCommand("copy")) throw new Error("Copy failed")
  } finally {
    textarea.remove()
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    if (selection) {
      selection.removeAllRanges()
      for (const range of previousRanges) selection.addRange(range)
    }
  }
}
