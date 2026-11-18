// What native tells the renderer about its surroundings (viewport insets, appearance, which chrome it draws), as a
// small external store next to the timeline store. Applied to the document directly where CSS needs it.
import type { HostMessage } from '@protocol/bridge'

type Of<T extends HostMessage['type']> = Omit<Extract<HostMessage, { type: T }>, 'type'>

/** `account` is sent by the iOS demo (not yet in bridge.ts): who the reader is, so their answers read 「你」. */
export type Appearance = Of<'appearance'> & { account?: { name: string } }

export interface Surroundings {
  viewport: Of<'viewport'>
  appearance: Appearance
  chrome: Of<'chrome'>
}

let state: Surroundings = {
  viewport: { top: 0, bottom: 0 },
  appearance: {
    scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    textScale: 1,
    reduceMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    locale: navigator.language || 'zh-CN',
  },
  // Native draws the approval dock unless it says otherwise; the dev host switches to inline.
  chrome: { approvals: 'host' },
}
const listeners = new Set<() => void>()

export const surroundings = {
  get: () => state,
  subscribe: (fn: () => void) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  set(patch: Partial<Surroundings>) {
    state = { ...state, ...patch }
    apply()
    for (const fn of listeners) fn()
  },
}

function apply() {
  const root = document.documentElement
  const { viewport, appearance } = state
  root.style.setProperty('--aa-top', `${Math.max(0, viewport.top)}px`)
  root.style.setProperty('--aa-bottom', `${Math.max(0, viewport.bottom)}px`)
  root.classList.toggle('dark', appearance.scheme === 'dark')
  root.style.colorScheme = appearance.scheme
  // Everything is in rem, so the root size scales the whole thread. AI Elements' body text is text-sm (14px at a 16px
  // root), sized for desktop; iOS body text is 17pt. A root of 16 × 17/14 makes text-sm 17px and scales the rest (step
  // lines, code, spacing) with it, keeping the stock styles. Dynamic Type (textScale) multiplies on top.
  root.style.fontSize = `${Math.round(16 * (17 / 14) * (appearance.textScale || 1) * 100) / 100}px`
  root.classList.toggle('reduce-motion', appearance.reduceMotion)
  root.lang = appearance.locale || 'zh-CN'
}

apply()
