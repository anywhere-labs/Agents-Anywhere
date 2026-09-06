import { useCallback, useEffect, useId, useState } from 'react'
import { Button, Input, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { Cloud } from 'lucide-react'
import clsx from 'clsx'
import type { OnboardingHostApi, OnboardingSnapshot } from '../../../contracts/index.js'
import css from './section.module.css'

export function OnboardingSection({ host }: { host: OnboardingHostApi }) {
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [webBaseUrl, setWebBaseUrl] = useState('')
  const [apiBaseUrl, setApiBaseUrl] = useState('')
  const [showServer, setShowServer] = useState(false)
  const serverFormId = useId()

  const refresh = useCallback(async () => {
    const next = await host.inspect()
    setSnapshot(next)
    return next
  }, [host])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let first = true
    const poll = async () => {
      try {
        const next = await host.inspect()
        if (stopped) return
        setSnapshot(next)
        if (first) { setWebBaseUrl(next.settings.webBaseUrl); setApiBaseUrl(next.settings.apiBaseUrl); first = false }
      } catch (error) {
        if (!stopped) setError(error instanceof Error ? error.message : '读取插件状态失败。')
      }
      if (!stopped) timer = setTimeout(() => void poll(), 1_500)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [host])

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError(null)
    try { await action(); await refresh() }
    catch (error) { setError(error instanceof Error ? error.message : '操作失败，请重试。') }
    finally { setBusy(false) }
  }

  const begin = () => {
    void run(async () => {
      const result = await host.begin()
      setLink(result.url)
      // DSH Desktop forwards HTTP(S) window targets to the system browser and
      // denies the renderer window. An about:blank placeholder is discarded.
      // Keep the link available when a regular browser blocks an async popup.
      window.open(result.url, '_blank', 'noopener,noreferrer')
    })
  }

  const detected = snapshot?.desktop.status
  const connecting = snapshot?.stage === 'authorizing' || snapshot?.stage === 'starting' || snapshot?.stage === 'pairing'
  const failed = Boolean(error || snapshot?.stage === 'error' || detected === 'error')
  const state: StateDotState = failed ? 'error' : !snapshot || busy || connecting ? 'ongoing' : snapshot.stage === 'ready' ? 'done' : 'warning'
  const statusMessage = error
    ?? (detected === 'installed' ? '已检测到桌面端，请在桌面端继续连接。'
      : detected === 'error' ? snapshot?.desktop.message
        : snapshot?.account && snapshot.stage === 'ready' ? `已登录为 ${snapshot.account.displayName}`
          : connecting || snapshot?.stage === 'error' ? snapshot?.message : null)
  return <section className={css.section} aria-busy={busy}>
    <Button
      variant="primary"
      className={css.loginButton}
      icon={busy ? <StateDot state="ongoing" /> : <Cloud size={16} />}
      disabled={busy || detected !== 'absent'}
      onClick={begin}
    >
      {busy ? '正在连接…' : !snapshot ? '正在检查…' : snapshot.account ? '继续设置' : '登录云端'}
    </Button>
    {statusMessage ? <p className={clsx(css.status, failed && css.error)} role={failed ? 'alert' : 'status'}>
      <StateDot state={state} className={css.stateDot} />
      <span>{statusMessage}</span>
    </p> : null}
    {link ? <p className={css.hint}><a className={css.link} href={link} target="_blank" rel="noreferrer">浏览器没有打开？点击继续</a></p> : null}
    {connecting ? <Button variant="ghost" className={css.secondaryButton} disabled={busy} onClick={() => void run(async () => { await host.cancel(); setLink(null) })}>取消本次连接</Button> : null}
    {snapshot?.account ? <Button variant="ghost" className={css.secondaryButton} disabled={busy} onClick={() => void run(async () => { await host.logout(); setLink(null) })}>退出登录并断开设备</Button> : null}
    {failed ? <Button variant="outline" className={css.secondaryButton} disabled={busy} onClick={() => void run(refresh)}>重新检查</Button> : null}
    <Button
      variant="ghost"
      className={css.secondaryButton}
      disabled={busy}
      aria-expanded={showServer}
      aria-controls={serverFormId}
      onClick={() => setShowServer(value => !value)}
    >
      {showServer ? '收起服务设置' : '连接到自己的服务实例'}
    </Button>
    {showServer ? <form id={serverFormId} className={css.form} onSubmit={(event) => { event.preventDefault(); void run(async () => { await host.configure({ apiBaseUrl, webBaseUrl }); setLink(null) }) }}>
      <label className={css.field}>Web 应用地址<Input className={clsx(css.input)} type="url" autoCapitalize="none" spellCheck={false} disabled={busy} required value={webBaseUrl} onChange={(event) => setWebBaseUrl(event.target.value)} /></label>
      <label className={css.field}>服务地址<Input className={clsx(css.input)} type="url" autoCapitalize="none" spellCheck={false} disabled={busy} required value={apiBaseUrl} onChange={(event) => setApiBaseUrl(event.target.value)} /></label>
      <p className={css.hint}>修改地址会退出当前账号并停止本机连接。</p>
      <Button variant="outline" className={css.secondaryButton} type="submit" disabled={busy}>保存连接地址</Button>
    </form> : null}
  </section>
}
