import { translateMessage, type Translate } from '../../locales.js'
import { useState } from 'react'
import { Button, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { Globe, User } from 'lucide-react'
import type { AccountProfile, OnboardingHostApi, OnboardingSnapshot } from '../../../contracts/index.js'
import { resolveWebAppUrl } from '../../../contracts/web-address.js'
import type { OnboardingState } from './state.js'
import css from './account-panel.module.css'
import { MobileConnection } from './mobile-connection.js'

export function connectorStatus(snapshot: OnboardingSnapshot, readError: string | null, t: Translate): { label: string; state: StateDotState; detail?: string } {
  if (readError) return { label: t('状态暂不可用'), state: 'warning', detail: readError }
  if (snapshot.stage === 'pairing' || snapshot.stage === 'starting' || snapshot.stage === 'authorizing') {
    return { label: t('正在启动'), state: 'ongoing', detail: snapshot.message }
  }
  if (snapshot.deviceRecovery) {
    const recovery = snapshot.deviceRecovery
    return { label: recovery.status === 'checking' ? t('正在检查') : recovery.status === 'deleted' ? t('设备已删除') : t('已断开'),
      state: recovery.status === 'checking' ? 'ongoing' : 'warning', detail: recovery.message }
  }
  if (snapshot.stage === 'error') return { label: t('运行异常'), state: 'error', detail: snapshot.message }
  if (snapshot.connector?.lastError) return { label: t('运行异常'), state: 'error', detail: snapshot.connector.lastError }
  return snapshot.connectorRunning ? { label: t('运行中'), state: 'done' } : { label: t('未运行'), state: 'warning' }
}

export function AccountPanel({ t, host, state, snapshot, account }: {
  t: Translate
  host: OnboardingHostApi
  state: OnboardingState
  snapshot: OnboardingSnapshot
  account: AccountProfile
}) {
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const [loginUrl, setLoginUrl] = useState<string | null>(null)
  const [onboardingUrl, setOnboardingUrl] = useState<string | null>(null)
  const status = connectorStatus(snapshot, state.readError, t)
  const recovery = snapshot.deviceRecovery
  const recoveryLabel = recovery?.status === 'deleted' ? t('重新配置') : recovery?.status === 'disconnected' ? t('重新连接')
    : recovery?.status === 'login_required' ? t('重新登录') : t('重新检查')
  const avatar = account.avatar && account.avatar !== failedAvatar ? account.avatar : null
  // Client HMR can arrive before the Host reloads. The backend address exists
  // in older snapshots, so this action remains usable throughout development.
  const webAppUrl = snapshot.webAppUrl || resolveWebAppUrl(snapshot.settings.apiBaseUrl)

  return <section className={css.panel} aria-busy={state.busy}>
    <div className={css.profile} aria-label={t('账号信息')}>
      <span className={css.avatar}>
        {avatar ? <img src={avatar} alt={t('{name}的头像', { name: account.displayName })} onError={() => setFailedAvatar(avatar)} />
          : <User size={28} strokeWidth={1.5} />}
      </span>
      <div className={css.identity}>
        <p className={css.name}>{account.displayName}</p>
        {account.email ? <p className={css.secondary}>{account.email}</p> : null}
        <p className={css.server}>{snapshot.settings.apiBaseUrl}</p>
      </div>
    </div>
    <div className={css.connector} role="status" aria-live="polite">
      <span>Connector</span>
      <span className={css.indicator}><StateDot state={status.state} /><span>{status.label}</span></span>
      {status.detail ? <p className={css.detail}>{translateMessage(t, status.detail)}</p> : null}
      {recovery && recovery.status !== 'checking' ? <Button
        variant="outline"
        className={css.recover}
        disabled={state.busy || Boolean(state.readError)}
        onClick={() => void state.run(async () => {
          setOnboardingUrl(null)
          if (recovery.status === 'login_required') {
            const result = await host.begin()
            setLoginUrl(result.url)
            window.open(result.url, '_blank', 'noopener,noreferrer')
          } else {
            const result = await host.recoverDevice(recovery.status === 'deleted' ? 'recreate' : recovery.status === 'disconnected' ? 'reconnect' : 'check')
            if (result?.url) {
              setOnboardingUrl(result.url)
              window.open(result.url, '_blank', 'noopener,noreferrer')
            }
          }
        })}
      >{state.busy && !loggingOut ? t('正在处理…') : recoveryLabel}</Button> : null}
      {loginUrl && snapshot.stage === 'authorizing' ? <a className={css.detail} href={loginUrl} target="_blank" rel="noreferrer">{t('浏览器没有打开？点击继续登录')}</a> : null}
      {onboardingUrl && snapshot.stage === 'ready' && !recovery ? <a className={css.detail} href={onboardingUrl} target="_blank" rel="noreferrer">{t('浏览器没有打开？点击继续配置')}</a> : null}
    </div>
    <div className={css.actions}>
      <Button
        variant="primary"
        className={css.button}
        icon={<Globe size={16} strokeWidth={1.5} />}
        disabled={state.busy}
        onClick={() => window.open(webAppUrl, '_blank', 'noopener,noreferrer')}
      >{t('打开 Web')}</Button>
      <MobileConnection t={t} host={host} disabled={state.busy || Boolean(state.readError)} />
      <Button variant="ghost" className={css.button} disabled={state.busy} onClick={() => void state.run(async () => {
        setLoggingOut(true)
        try { await host.logout() } finally { setLoggingOut(false) }
      })}>
        {loggingOut ? t('正在退出…') : t('退出登录')}
      </Button>
    </div>
    {state.error ? <p className={css.error} role="alert">{translateMessage(t, state.error)}</p> : null}
  </section>
}
