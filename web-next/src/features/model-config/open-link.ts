/**
 * Open the one-time link start address in the browser that will authorize it.
 * The link finishes there; this page learns the result from the snapshot.
 */
export async function openTokensLinkStart(startUrl: string): Promise<void> {
  // `noopener` would make window.open return null, so detach the opener instead.
  const opened = window.open(startUrl, "_blank")
  if (opened) opened.opener = null
  else window.location.assign(startUrl)
}
