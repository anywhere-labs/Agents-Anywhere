import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { createElement, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { LOCALE_NS, type Translate } from '../src/client/locales.ts'

/** Load the published DSH locale factory just as the browser module loader does.
 * The unused Language settings row's store is not needed by LocaleRuntime. */
export function loadTestLocale(ctx: Context, requireModule: (id: string) => unknown): LocaleRuntime {
  const require = createRequire(import.meta.url)
  let Locale: typeof LocaleRuntime | undefined
  runInNewContext(readFileSync(require.resolve('@deepseek-ai/dsh-client-locale/client'), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }: { factory: (require: (id: string) => unknown) => { LocaleRuntime: typeof LocaleRuntime } }) => {
      Locale = factory(id => id === '@deepseek-ai/dsh-client-store' ? {} : requireModule(id)).LocaleRuntime
    } } },
    document, navigator: { languages: ['zh-CN'], language: 'zh-CN' }, console,
  })
  if (!Locale) throw new Error('DSH locale factory did not register')
  return new Locale(ctx)
}

/** Reproduce the slot renderer's locale seat: subscribe to revision and pass t
 * to the same mounted entry. There is no language key that would remount it. */
export function localeEntry<P extends object>(locale: LocaleRuntime, Entry: ComponentType<P & { t: Translate }>): ComponentType<P> {
  const subscribe = (fn: () => void) => locale.subscribe(fn)
  const snapshot = () => locale.getSnapshot().revision
  return function LocaleEntry(props: P) {
    useSyncExternalStore(subscribe, snapshot, snapshot)
    return createElement(Entry, { ...props, t: locale.bind(LOCALE_NS) })
  }
}
