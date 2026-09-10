import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OnboardingHostApi } from '../../../contracts/index.js'
import type { BridgeLogSnapshot } from '../../../contracts/logs.js'
import css from './bridge-logs-panel.module.css'

export function BridgeLogsPanel({ host }: { host: OnboardingHostApi }) {
  const [snapshot, setSnapshot] = useState<BridgeLogSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [busy, setBusy] = useState(false)
  const active = useRef(false)
  const loading = useRef(false)
  const refresh = useCallback(async () => {
    if (loading.current) return
    loading.current = true
    setBusy(true)
    try {
      const next = await host.readBridgeLogs()
      if (active.current) { setSnapshot(next); setError(null) }
    } catch {
      if (active.current) setError('暂时无法读取桥接日志，请重试。')
    } finally {
      loading.current = false
      if (active.current) setBusy(false)
    }
  }, [host])
  useEffect(() => {
    active.current = true
    void refresh()
    return () => { active.current = false }
  }, [refresh])
  useEffect(() => {
    if (paused) return
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh() }, 2000)
    return () => clearInterval(timer)
  }, [paused, refresh])

  return <section className={css.panel} aria-label="桥接日志">
    <div className={css.toolbar}>
      <div><h3>桥接日志</h3><p>Anywhere Bridge · 最近 200 条</p></div>
      <div className={css.actions}>
        <Button variant="ghost" onClick={() => setPaused(value => !value)}>{paused ? '继续刷新' : '暂停刷新'}</Button>
        <Button variant="outline" disabled={busy} onClick={() => void refresh()}>刷新</Button>
      </div>
    </div>
    <p className={css.status} role="status">{snapshot ? `${paused ? '已暂停' : '每 2 秒刷新'} · 更新于 ${new Date(snapshot.updatedAt).toLocaleTimeString()}` : '正在读取桥接日志…'}</p>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    {snapshot?.entries.length === 0 ? <p className={css.empty}>还没有桥接日志。插件启动后，连接和会话同步的记录会显示在这里。</p> : null}
    <ol className={css.entries} aria-label="桥接日志记录" tabIndex={0}>
      {[...(snapshot?.entries ?? [])].reverse().map((entry, index) => <li key={`${entry.time}-${index}`} className={css.entry} data-level={entry.level}>
        <div className={css.meta}><time dateTime={entry.time}>{new Date(entry.time).toLocaleTimeString()}</time><strong>{entry.level.toUpperCase()}</strong><code>{entry.event}</code></div>
        <pre>{entry.details}</pre>
      </li>)}
    </ol>
  </section>
}
