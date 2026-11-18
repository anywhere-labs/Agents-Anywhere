// The renderer's side of aa.render/1 (v3poc/protocol/bridge.ts). Native calls `window.aaRenderer.receive(message)`;
// the renderer posts to `window.webkit.messageHandlers.aa` (iOS) or `window.aaHost` (Android). In a plain browser there
// is neither, and a dev host (dev-host.ts) plays the fixture instead.
import type { HostMessage, RendererMessage } from '@protocol/bridge'

declare global {
  interface Window {
    aaRenderer?: { receive: (message: HostMessage | string) => void }
    webkit?: { messageHandlers?: { aa?: { postMessage: (message: unknown) => void } } }
    aaHost?: { postMessage: (json: string) => void }
  }
}

export type NativeKind = 'ios' | 'android' | null

export function nativeHost(): NativeKind {
  if (window.webkit?.messageHandlers?.aa) return 'ios'
  if (window.aaHost) return 'android'
  return null
}

let fallback: ((m: RendererMessage) => void) | null = null

/** Where messages go when there is no native host (the dev host). */
export function setFallbackHost(fn: (m: RendererMessage) => void) {
  fallback = fn
}

export function post(message: RendererMessage) {
  const ios = window.webkit?.messageHandlers?.aa
  if (ios) return ios.postMessage(message)
  if (window.aaHost) return window.aaHost.postMessage(JSON.stringify(message))
  fallback?.(message)
}
