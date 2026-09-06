import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button, Input, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { Cloud, Server } from 'lucide-react'
import clsx from 'clsx'
import type { OnboardingHostApi, OnboardingSnapshot } from '../../../contracts/index.js'
import css from './section.module.css'

export function OnboardingSection({ host }: { host: OnboardingHostApi }) {
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [serverUrl, setServerUrl] = useState('')
  const [showServer, setShowServer] = useState(false)
  const [loginTarget, setLoginTarget] = useState<'cloud' | 'server' | 'current'>('cloud')
  const running = useRef(false)
  const serverFormId = useId()
  const errorId = useId()

  const refresh = useCallback(async () => {
    const next = await host.inspect()
    setSnapshot(next)
    return next
  }, [host])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await host.inspect()
        if (stopped) return
        setSnapshot(next)
      } catch (error) {
        if (!stopped) setError(error instanceof Error ? error.message : '读取插件状态失败。')
      }
      if (!stopped) timer = setTimeout(() => void poll(), 1_500)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [host])

  const run = async (action: () => Promise<unknown>) => {
    if (running.current) return
    running.current = true
    setBusy(true); setError(null)
    try { await action(); await refresh() }
    catch (error) { setError(error instanceof Error ? error.message : '操作失败，请重试。') }
    finally { running.current = false; setBusy(false) }
  }

  const begin = (target: 'cloud' | 'server' | 'current') => {
    void run(async () => {
      setLoginTarget(target)
      setLink(null)
      const result = await host.begin(target === 'current' ? undefined
        : target === 'cloud' ? { target } : { target, serverUrl })
      setLink(result.url)
      // DSH Desktop forwards HTTP(S) window targets to the system browser and
      // denies the renderer window. An about:blank placeholder is discarded.
      // Keep the link available when a regular browser blocks an async popup.
      window.open(result.url, '_blank', 'noopener,noreferrer')
    })
  }

  const detected = snapshot?.desktop.status
  const unavailable = busy || detected !== 'absent'
  const primaryBusy = busy && loginTarget !== 'server'
  const serverBusy = busy && loginTarget === 'server'
  const connecting = snapshot?.stage === 'authorizing' || snapshot?.stage === 'starting' || snapshot?.stage === 'pairing'
  const failed = Boolean(error || snapshot?.stage === 'error' || detected === 'error')
  const state: StateDotState = failed ? 'error' : !snapshot || busy || connecting ? 'ongoing' : snapshot.stage === 'ready' ? 'done' : 'warning'
  const statusMessage = error
    ?? (detected === 'installed' ? '已检测到桌面端，请在桌面端继续连接。'
      : detected === 'error' ? snapshot?.desktop.message
        : snapshot?.account && snapshot.stage === 'ready' ? `已登录为 ${snapshot.account.displayName}`
          : snapshot?.stage === 'authorizing' ? '已打开登录页面，完成登录后将自动返回。'
            : connecting || snapshot?.stage === 'error' ? snapshot?.message : null)
  return <section className={css.section} aria-busy={busy}>
    <Button
      variant="primary"
      className={css.loginButton}
      icon={primaryBusy ? <StateDot state="ongoing" /> : <Cloud size={16} />}
      disabled={unavailable}
      onClick={() => begin(snapshot?.account ? 'current' : 'cloud')}
    >
      {primaryBusy ? '正在连接…' : snapshot?.account ? '继续设置' : '登录 Agents Anywhere Cloud'}
    </Button>
    {showServer ? <form id={serverFormId} className={css.form} onSubmit={(event) => {
      event.preventDefault()
      if (serverUrl.trim() && !unavailable) begin('server')
    }}>
      <p className={css.separator} aria-hidden="true">OR</p>
      <div className={css.fields}>
        <label className={css.field} htmlFor={`${serverFormId}-url`}>
          连接到你自己的 Agents Anywhere 服务实例
        </label>
        <Input
          id={`${serverFormId}-url`}
          className={clsx(css.input)}
          icon={<Server size={16} aria-hidden="true" />}
          type="text"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          required
          disabled={unavailable}
          value={serverUrl}
          onChange={(event) => { setServerUrl(event.target.value); setError(null) }}
          placeholder="输入服务器地址，例如 https://your-server.com"
          aria-invalid={Boolean(error && loginTarget === 'server')}
          aria-describedby={error ? errorId : undefined}
        />
        <Button
          variant="primary"
          className={css.loginButton}
          type="submit"
          icon={serverBusy ? <StateDot state="ongoing" /> : null}
          disabled={unavailable || !serverUrl.trim()}
        >{serverBusy ? '正在连接…' : '连接服务器'}</Button>
      </div>
    </form> : <Button
      variant="ghost"
      className={css.secondaryButton}
      disabled={busy}
      aria-expanded={showServer}
      aria-controls={serverFormId}
      onClick={() => { setShowServer(true); setError(null) }}
    >连接到你自己的 Agents Anywhere 服务实例</Button>}
    {statusMessage ? <p id={errorId} className={clsx(css.status, failed && css.error)} role={failed ? 'alert' : 'status'}>
      <StateDot state={state} className={css.stateDot} />
      <span>{statusMessage}</span>
    </p> : null}
    {link ? <p className={css.hint}><a className={css.link} href={link} target="_blank" rel="noreferrer">浏览器没有打开？点击继续</a></p> : null}
    {connecting ? <Button variant="ghost" className={css.secondaryButton} disabled={busy} onClick={() => void run(async () => { await host.cancel(); setLink(null) })}>取消本次连接</Button> : null}
    {snapshot?.account ? <Button variant="ghost" className={css.secondaryButton} disabled={busy} onClick={() => void run(async () => { await host.logout(); setLink(null) })}>退出登录并断开设备</Button> : null}
    {failed ? <Button variant="outline" className={css.secondaryButton} disabled={busy} onClick={() => void run(refresh)}>重新检查</Button> : null}
  </section>
}
