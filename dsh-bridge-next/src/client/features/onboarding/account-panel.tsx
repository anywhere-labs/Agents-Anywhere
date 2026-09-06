import { useState } from 'react'
import { Button, IconGlobeOutline14, IconUserOutline16, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountProfile, OnboardingHostApi, OnboardingSnapshot } from '../../../contracts/index.js'
import { resolveWebAppUrl } from '../../../contracts/web-address.js'
import type { OnboardingState } from './state.js'
import css from './account-panel.module.css'

function connectorStatus(snapshot: OnboardingSnapshot, readError: string | null): { label: string; state: StateDotState; detail?: string } {
  if (readError) return { label: '状态暂不可用', state: 'warning', detail: readError }
  if (snapshot.stage === 'error') return { label: '运行异常', state: 'error', detail: snapshot.message }
  if (snapshot.stage === 'pairing' || snapshot.stage === 'starting' || snapshot.stage === 'authorizing') {
    return { label: '正在启动', state: 'ongoing', detail: snapshot.message }
  }
  return snapshot.connectorRunning ? { label: '运行中', state: 'done' } : { label: '未运行', state: 'warning' }
}

export function AccountPanel({ host, state, snapshot, account }: {
  host: OnboardingHostApi
  state: OnboardingState
  snapshot: OnboardingSnapshot
  account: AccountProfile
}) {
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null)
  const status = connectorStatus(snapshot, state.readError)
  const avatar = account.avatar && account.avatar !== failedAvatar ? account.avatar : null
  // Client HMR can arrive before the Host reloads. The backend address exists
  // in older snapshots, so this action remains usable throughout development.
  const webAppUrl = snapshot.webAppUrl || resolveWebAppUrl(snapshot.settings.apiBaseUrl)

  return <section className={css.panel} aria-busy={state.busy}>
    <div className={css.profile} aria-label="账号信息">
      <span className={css.avatar}>
        {avatar ? <img src={avatar} alt={`${account.displayName}的头像`} onError={() => setFailedAvatar(avatar)} />
          : <IconUserOutline16 size={28} />}
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
      {status.detail ? <p className={css.detail}>{status.detail}</p> : null}
    </div>
    <div className={css.actions}>
      <Button
        variant="primary"
        className={css.button}
        icon={<IconGlobeOutline14 size={16} />}
        disabled={state.busy}
        onClick={() => window.open(webAppUrl, '_blank', 'noopener,noreferrer')}
      >打开 Web</Button>
      <Button variant="ghost" className={css.button} disabled={state.busy} onClick={() => void state.run(() => host.logout())}>
        {state.busy ? '正在退出…' : '退出登录'}
      </Button>
    </div>
    {state.error ? <p className={css.error} role="alert">{state.error}</p> : null}
  </section>
}
