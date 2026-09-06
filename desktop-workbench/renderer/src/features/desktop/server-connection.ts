import type { DesktopServerConnection } from "./bridge"

export const DESKTOP_API_PROXY_ORIGIN = "aa-workbench://web"

let connection: DesktopServerConnection | null = null

export function setDesktopServerConnection(server: DesktopServerConnection): void {
  connection = { ...server }
}

export function getDesktopServerConnection(): DesktopServerConnection | null {
  return connection
}

export function desktopApiProxyBase(): string {
  return connection ? DESKTOP_API_PROXY_ORIGIN : ""
}

// Server-generated download links also use Main's proxy, preserving auth and
// avoiding cross-origin restrictions in both packaged and development builds.
export function desktopDownloadUrl(value: string): string {
  if (!connection) return value
  const url = new URL(value, connection.serverUrl)
  const namespace = connection.apiNamespace
  if (url.origin !== connection.serverUrl ||
    (namespace && url.pathname !== namespace && !url.pathname.startsWith(`${namespace}/`))) return value
  return `${DESKTOP_API_PROXY_ORIGIN}${url.pathname}${url.search}${url.hash}`
}
