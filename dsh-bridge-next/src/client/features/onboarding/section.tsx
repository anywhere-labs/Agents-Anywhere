import { useCallback, useEffect, useState } from 'react'
import { Button, Input, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
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
    // Create the tab during the gesture so async Host RPC cannot trigger a
    // popup blocker. The fallback link remains available in embedded clients.
    const tab = window.open('about:blank', '_blank')
    if (tab) tab.opener = null
    void run(async () => {
      try {
        const result = await host.begin()
        setLink(result.url)
        if (tab) tab.location.replace(result.url)
      } catch (error) { tab?.close(); throw error }
    })
  }

  const detected = snapshot?.desktop.status
  const connecting = snapshot?.stage === 'authorizing' || snapshot?.stage === 'starting' || snapshot?.stage === 'pairing'
  const failed = Boolean(error || snapshot?.stage === 'error' || detected === 'error')
  const state: StateDotState = failed ? 'error' : !snapshot || busy || connecting ? 'ongoing' : snapshot.stage === 'ready' ? 'done' : 'warning'
  return <section className={css.section} aria-busy={busy}>
    <header className={css.heading}>
      <span className={css.eyebrow}>AGENTS ANYWHERE</span>
      <h2 className={css.title}>把这台电脑连接起来</h2>
      <p className={css.description}>在 Web 和手机上继续使用你的 Agent。登录后，我们会为本机建立连接，并引导你完成设置。</p>
    </header>
    <div className={clsx(css.status, failed && css.statusError)} role="status" aria-live="polite">
      <StateDot state={state} className={css.stateDot} />
      <div className={css.statusBody}>
        <strong className={css.statusTitle}>{snapshot?.account ? `你好，${snapshot.account.displayName}` : '开始设置'}</strong>
        <p className={css.description}>{detected && detected !== 'absent' ? snapshot?.desktop.message : snapshot?.message ?? '正在检查本机…'}</p>
        {snapshot?.connectorId ? <small className={css.device}>设备：{snapshot.connectorId}</small> : null}
      </div>
    </div>
    {error ? <p role="alert" className={css.error}>{error}</p> : null}
    <div className={css.actions}>
      <Button variant="primary" disabled={busy || detected !== 'absent'} onClick={begin}>{busy ? '正在准备…' : snapshot?.account ? '继续 Web 引导' : '在浏览器中登录'}</Button>
      {connecting ? <Button variant="outline" disabled={busy} onClick={() => void run(async () => { await host.cancel(); setLink(null) })}>取消本次连接</Button> : null}
      {snapshot?.account ? <Button variant="ghost" disabled={busy} onClick={() => void run(async () => { await host.logout(); setLink(null) })}>退出登录并断开设备</Button> : null}
      {detected === 'error' ? <Button variant="outline" disabled={busy} onClick={() => void run(refresh)}>重新检查</Button> : null}
    </div>
    {link ? <p className={css.hint}><a className={css.link} href={link} target="_blank" rel="noreferrer">浏览器没有打开？点击继续</a></p> : null}
    <details className={css.connectionSettings}><summary className={css.summary}>连接地址</summary><form className={css.form} onSubmit={(event) => { event.preventDefault(); void run(async () => { await host.configure({ apiBaseUrl, webBaseUrl }); setLink(null) }) }}>
      <label className={css.field}>Web 应用地址<Input className={clsx(css.input)} type="url" required value={webBaseUrl} onChange={(event) => setWebBaseUrl(event.target.value)} /></label>
      <label className={css.field}>服务地址<Input className={clsx(css.input)} type="url" required value={apiBaseUrl} onChange={(event) => setApiBaseUrl(event.target.value)} /></label>
      <p className={css.hint}>修改地址会退出当前账号并停止本机连接。</p>
      <div className={css.actions}><Button variant="outline" type="submit" disabled={busy}>保存连接地址</Button></div>
    </form></details>
  </section>
}
