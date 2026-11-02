import { getDesktopWorkbenchBridge } from "@/features/desktop/bridge"

/**
 * Open the one-time link start address in the system browser, which then
 * holds the link's cookie and finishes it. This window learns the result
 * from the snapshot.
 */
export async function openTokensLinkStart(startUrl: string): Promise<void> {
  const bridge = getDesktopWorkbenchBridge()
  if (bridge) {
    await bridge.openExternal(startUrl)
    return
  }
  const opened = window.open(startUrl, "_blank")
  if (opened) opened.opener = null
  else window.location.assign(startUrl)
}
