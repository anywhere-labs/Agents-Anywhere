/** Reserve the authorization window during the click, before awaiting the API. */
export function createTokensLinkWindow(): Window | null {
  const width = Math.min(520, window.screen.availWidth)
  const height = Math.min(720, window.screen.availHeight)
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2))
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2))
  const opened = window.open(
    "about:blank",
    "_blank",
    `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`,
  )
  // Keep our handle for navigation/closing without giving the remote page an opener.
  if (opened) opened.opener = null
  return opened
}

/** The link finishes in the popup; the main page learns the result from its snapshot. */
export function openTokensLinkStart(startUrl: string, popup: Window | null): void {
  if (popup) {
    // Closing the window while the request is pending cancels navigation.
    if (!popup.closed) popup.location.replace(startUrl)
  } else {
    // Retain the existing full-page fallback when the browser blocks popups.
    window.location.assign(startUrl)
  }
}

/** A Tokens Anywhere console page, in a new browser tab. */
export async function openExternal(url: string): Promise<void> {
  const opened = window.open(url, "_blank")
  if (opened) opened.opener = null
}
