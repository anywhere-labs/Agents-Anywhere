// aa.render/1 — the bridge between a native app (iOS, Android) and the conversation renderer in its WebView.
//
// The native app keeps the connection (the `watch` stream), the cache, credentials and every control around the
// thread (toolbar, composer, approval dock, sheets). It forwards watch events to the renderer unchanged; the
// renderer applies them exactly as the web client does and reports what the reader does. The renderer never makes a
// request with credentials: attachments and images load through the host's URL scheme (`aa-app://file?path=…`).
//
// Native → renderer: `window.aaRenderer.receive(message)` (evaluateJavaScript / callAsyncJavaScript).
// Renderer → native: `window.webkit.messageHandlers.aa.postMessage(message)` on iOS,
//                    `window.aaHost.postMessage(JSON.stringify(message))` on Android.

import type { ID, Message, WatchEvent } from './timeline'

export const RENDER_PROTOCOL = 'aa.render/1' as const

export type HostMessage =
  /** Watch events, in order, unchanged. A `snapshot` replaces everything (a session opened, or the stream restarted). */
  | { type: 'watch'; events: WatchEvent[] }
  /** A page of older items, answering `loadOlder` (`list_messages({before_seq})`). */
  | { type: 'older'; messages: Message[]; has_more: boolean }
  /**
   * What native draws over the thread, in CSS px. The renderer pads its content by these so the first and last
   * items can scroll out from under the glass toolbar and composer; the document still scrolls under them.
   */
  | { type: 'viewport'; top: number; bottom: number }
  | { type: 'appearance'; scheme: 'light' | 'dark'; textScale: number; reduceMotion: boolean; locale: string; account?: { name: string } }
  /**
   * Which interactive pieces native draws itself. `approvals: 'host'`: the renderer marks the waiting tool call
   * ("等待你确认") and leaves the buttons to the native dock.
   */
  | { type: 'chrome'; approvals: 'inline' | 'host' }
  | { type: 'scrollToEnd'; animated: boolean }
  /**
   * The OS is short of memory (iOS `didReceiveMemoryWarning`, Android `onTrimMemory`). The renderer lets go of the DOM
   * of turns off screen and of older items (they come back through `loadOlder`), and keeps less from then on.
   */
  | { type: 'memoryPressure'; level: 'warning' | 'critical' }

export type OpenTarget = { kind: 'file'; path: string; line?: number } | { kind: 'url'; url: string }

export type RendererMessage =
  | { type: 'ready'; protocol: typeof RENDER_PROTOCOL; renderer: string }
  /** The reader's position changed (debounced). Native shows its own "到底部" glass button from `atEnd`. */
  | { type: 'scroll'; atEnd: boolean; atTop: boolean }
  | { type: 'loadOlder'; before_seq: number }
  /** An inline approval button (only when chrome.approvals is 'inline'). */
  | { type: 'answer'; request_id: ID; option_id: ID }
  | { type: 'open'; target: OpenTarget }
  | { type: 'copy'; text: string }
  /** Message actions the host performs (they need the connection). */
  | { type: 'rewind'; message_id: ID }
  | { type: 'fork'; message_id: ID }
  | { type: 'haptic'; style: 'light' | 'medium' | 'success' }
