import { LOCALE_NS, translateMessage, type Translate } from './locales.js'
/** Contribute AA settings inside the official bundle detail layout. */
import type { ComponentType } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OnboardingHostApi } from '../contracts/index.js'
import { ConnectionEntry } from './features/onboarding/entry.js'
import { SettingsPanel } from './features/onboarding/settings-panel.js'
import { useOnboardingState } from './features/onboarding/state.js'

const PACKAGE = '@agents-anywhere/dsh-bridge-next'

// Structural slot contracts keep AA compatible with older DSH installations
// that do not declare the plugin manager slots yet.
export interface PluginSettingsSlots {
  inject(name: string, callback: () => () => void): () => void
  register<P>(options: {
    name: string; id?: string; key?: string; order?: number; label?: () => string; locale: string
    inject: () => { host: OnboardingHostApi }
  }, component: ComponentType<P>): () => void
}

export function registerPluginSettings(slots: PluginSettingsSlots, host: OnboardingHostApi): () => void {
  const settings = slots.inject('plugins.bundle.config', () => slots.register({
    name: 'plugins.bundle.config', key: PACKAGE, locale: LOCALE_NS, inject: () => ({ host }),
  }, PluginSettings))
  const actions = slots.inject('plugins.detail.actions', () => slots.register({
    name: 'plugins.detail.actions', id: 'agents-anywhere-panel', order: 20, locale: LOCALE_NS, inject: () => ({ host }),
  }, PluginActions))
  return () => { actions(); settings() }
}

function PluginActions({ host, t, subject }: {
  t: Translate; host: OnboardingHostApi; subject: { kind: string; pkg?: { name: string; enabled: boolean } }
}) {
  if (subject.kind !== 'bundle' || subject.pkg?.name !== PACKAGE || !subject.pkg.enabled) return null
  return <ConnectionEntry t={t} host={host} wide renderTrigger={open =>
    <Button variant="outline" size="sm" onClick={open}>{t('打开面板')}</Button>} />
}

function PluginSettings({ host, t }: { t: Translate; host: OnboardingHostApi }) {
  return <ConnectionEntry t={t} host={host} wide renderTrigger={open => <ConnectionSettings t={t} host={host} onConnection={open} />} />
}

function ConnectionSettings({ host, t, onConnection }: { t: Translate; host: OnboardingHostApi; onConnection(): void }) {
  const state = useOnboardingState(host, true)
  const snapshot = state.snapshot
  if (!snapshot || state.readError || snapshot.desktop.status === 'error') return <>
    <p role={state.readError || snapshot?.desktop.status === 'error' ? 'alert' : 'status'}>
      {translateMessage(t, state.readError ?? (snapshot?.desktop.status === 'error' ? snapshot.desktop.message : '正在读取连接设置…'))}
    </p>
    {state.readError || snapshot?.desktop.status === 'error'
      ? <Button variant="outline" disabled={state.busy} onClick={() => { void state.run(state.refresh) }}>{t('重新检查')}</Button> : null}
  </>
  if (snapshot.desktop.status === 'installed') return <>
    <p>{t('Agents Anywhere 桌面端正在运行。请在桌面端管理连接设置。')}</p>
    <Button variant="outline" disabled={state.busy} onClick={() => { void state.run(() => host.openDesktop()) }}>{t('打开 Agents Anywhere')}</Button>
    {state.error ? <p role="alert">{translateMessage(t, state.error)}</p> : null}
  </>
  if (snapshot.ownership && snapshot.ownership.status !== 'owned') return <p role="alert">{translateMessage(t, snapshot.ownership.message || '暂时无法检查本机 Connector 状态，请稍后重试。')}</p>
  return <SettingsPanel t={t} host={host} state={state} snapshot={snapshot} onConnection={onConnection} />
}
