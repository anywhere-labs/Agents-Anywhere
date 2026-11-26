// Desktop (Electron, `desktop-v3/`) integration.
//
// The desktop app loads this workbench from its own bundle (`app://` protocol, static export built with
// `AA_DESKTOP_EXPORT=1`), so it is a "verified app" in the E2EE model: encrypted devices render the green lock.
// Its preload script exposes a small typed bridge as `window.aaDesktop`; secrets that a browser keeps in
// IndexedDB (client E2E private key, refresh tokens) go to the OS keychain through `secureStore` instead.
//
// Everything here is a no-op in the browser: `getDesktopBridge()` returns `null`.

import type { TrustTier } from "@/lib/types/v3"

export type DesktopConnectorMode = "normal" | "encrypted"

export interface DesktopProcessStatus {
  state: "stopped" | "starting" | "running" | "backoff" | "failed"
  pid: number | null
  restarts: number
  lastExitCode: number | null
  lastError: string | null
}

export interface DesktopConnectorStatus {
  registered: boolean
  deviceId: string | null
  deviceName: string | null
  mode: DesktopConnectorMode | null
  controlUrl: string | null
  connector: DesktopProcessStatus
  localRouter: { url: string; httpUrl: string } | null
  runtimes: { id: string; name: string }[]
  dataDir: string
  logFile: string
}

export interface DesktopPairResult {
  uri: string
  expires_at: string
  /** QR code of `uri` as SVG markup, rendered locally by the desktop main process. */
  qr_svg: string
}

export interface DesktopBridge {
  readonly version: string
  readonly platform: "darwin" | "win32" | "linux" | string
  secureStore: {
    available(): Promise<boolean>
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
  }
  connector: {
    status(): Promise<DesktopConnectorStatus>
    start(): Promise<DesktopConnectorStatus>
    stop(): Promise<DesktopConnectorStatus>
    register(input: {
      controlUrl: string
      accessToken: string
      name: string
      mode: DesktopConnectorMode
    }): Promise<DesktopConnectorStatus>
    pair(input?: { label?: string; ttlSeconds?: number }): Promise<DesktopPairResult>
    logs(lines?: number): Promise<string>
    onStatus(listener: (status: DesktopConnectorStatus) => void): () => void
  }
  settings: {
    get(): Promise<{ controlUrl: string }>
    setControlUrl(url: string): Promise<{ controlUrl: string }>
  }
  openExternal(url: string): Promise<void>
}

declare global {
  interface Window {
    aaDesktop?: DesktopBridge
  }
}

/** The desktop bridge when running inside `desktop-v3`, otherwise `null`. */
export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null
  return window.aaDesktop ?? null
}

export function isDesktopApp(): boolean {
  return getDesktopBridge() !== null
}

/** Trust tier of this client for pinned E2EE devices: the desktop bundle is verified, a browser is not. */
export function clientTrustTier(): TrustTier {
  return isDesktopApp() ? "verified_app" : "web_browser"
}

/** `client_platform` reported to the control plane at sign-in. */
export function clientPlatform(): "web" | "desktop" {
  return isDesktopApp() ? "desktop" : "web"
}

/**
 * URL to fetch a control-plane endpoint with. In the desktop app, absolute http(s) URLs go through the app's
 * own proxy (`app://aa/api/remote`), so control planes need no CORS allowance for the desktop origin;
 * `/api/control/*` is answered by the app directly. Unchanged in the browser.
 */
export function controlFetchUrl(url: string): string {
  if (!isDesktopApp() || !/^https?:\/\//.test(url)) return url
  return `/api/remote?url=${encodeURIComponent(url)}`
}

// ── Secrets ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Marker left in IndexedDB where the real value lives in the OS keychain. */
export const KEYCHAIN_PLACEHOLDER = "@aa-desktop-keychain"

/**
 * Move `value` into the OS keychain under `key` and return what IndexedDB should keep instead.
 * Without the desktop bridge (or when the keychain is unavailable) the value itself is returned.
 */
export async function sealSecret(key: string, value: string | null | undefined): Promise<string | null> {
  if (value === null || value === undefined || value === "") return value ?? null
  const bridge = getDesktopBridge()
  if (!bridge || !(await bridge.secureStore.available().catch(() => false))) return value
  await bridge.secureStore.set(key, value)
  return KEYCHAIN_PLACEHOLDER
}

/** Resolve a value written by `sealSecret`. */
export async function openSecret(key: string, stored: string | null | undefined): Promise<string | null> {
  if (stored !== KEYCHAIN_PLACEHOLDER) return stored ?? null
  const bridge = getDesktopBridge()
  if (!bridge) return null
  return bridge.secureStore.get(key)
}

export async function forgetSecret(key: string): Promise<void> {
  const bridge = getDesktopBridge()
  if (bridge) await bridge.secureStore.delete(key).catch(() => undefined)
}
