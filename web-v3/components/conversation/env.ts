// What the thread needs from whoever hosts it (the web app, or the native app through the bridge). The thread itself
// never talks to a network: answering, opening, copying, rewinding and forking all go out through here.
import { createContext, useContext } from 'react'
export type OpenTarget = { kind: 'url'; url: string } | { kind: 'file'; path: string; line?: number }
import type { ControlsConfig } from 'streamdown'

export interface ThreadEnv {
  /** The reader's account name: answers by them read "你". */
  me: string
  /**
   * Who sent a message or answered a request, from the Connector's principal (`user:<id>/client:<id>`, `e2e:<key>`):
   * null for the reader themself (nothing is shown), else a name to show. Without it `me` is compared as is.
   */
  whoIs?: (author: string) => string | null
  /** `host`: the native app draws the approval buttons (its dock); the thread only marks the waiting call. */
  approvals: 'inline' | 'host'
  reduceMotion: boolean
  /** Where an attachment's bytes come from (`aa-app://file?path=…` on mobile, a local preview on the web). */
  imageSrc: (path: string, mime: string, name: string) => string
  /**
   * Where `imageSrc` has nothing yet (an image this browser did not send): read the bytes from the device and resolve
   * an object URL, or null when it cannot be read. The web reads them over the tunnel; mobile uses `imageSrc` only.
   */
  loadImage?: (path: string, mime: string) => Promise<string | null>
  answer: (request_id: string, option_id: string) => void
  open: (target: OpenTarget) => void
  copy: (text: string) => void
  rewind?: (message_id: string) => void
  /** Ask for the last reply again: the host resends the prompt `message_id` (a rewind with the same text). */
  regenerate?: (message_id: string) => void
  fork?: (message_id: string) => void
  haptic?: (style: 'light' | 'medium' | 'success') => void
  /** Streamdown's table / diagram buttons. The renderer turns fullscreen off (native has its own sheets). */
  markdownControls?: ControlsConfig
}

const noop = () => {}

export const ThreadEnvContext = createContext<ThreadEnv>({
  me: '',
  approvals: 'inline',
  reduceMotion: false,
  imageSrc: () => '',
  answer: noop,
  open: noop,
  copy: noop,
})

export const useThreadEnv = () => useContext(ThreadEnvContext)
