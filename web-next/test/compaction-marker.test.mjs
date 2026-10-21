import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { registerSource } from './helpers/onboarding-source.mjs'

const nextHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === 'next/dynamic' ? 'next/dynamic.js' : specifier, context)
  },
})
const sourceHook = registerSource()
const { createElement: h } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const { TimelineEntry } = await import('../src/components/session/session-timeline-entry.tsx')
sourceHook.deregister()
nextHook.deregister()

const messages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8'))

function render(type, status, state) {
  return renderToStaticMarkup(h(NextIntlClientProvider, { locale: 'en', messages, timeZone: 'UTC' },
    h(TimelineEntry, {
      token: 'test', session: { id: 'session', runtime: 'codex' },
      item: { id: 'compact', type, status, role: 'system', content: { kind: 'compact', state }, source: {} },
      resolvingNoticeId: null, resolvingActionId: null, onRespondInteraction() {},
    }),
  ))
}

for (const type of ['marker', 'system']) {
  test(`${type} compaction distinguishes running, completed and failed outcomes`, () => {
    const running = render(type, 'running', 'started')
    assert.match(running, /Compacting context/)
    assert.match(running, /shimmer/)
    const completed = render(type, 'done', 'completed')
    assert.match(completed, /Conversation compacted/)
    assert.doesNotMatch(completed, /shimmer/)
    const failed = render(type, 'failed', 'failed')
    assert.match(failed, /Context compaction did not complete/)
    assert.doesNotMatch(failed, /Conversation compacted|shimmer/)
  })

  test(`${type} failed status wins over stale compaction content`, () => {
    const failed = render(type, 'failed', 'started')
    assert.match(failed, /Context compaction did not complete/)
    assert.doesNotMatch(failed, /Compacting context|Conversation compacted|shimmer/)
  })
}
