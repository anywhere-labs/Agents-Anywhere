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
      if (active.current) setError('运行日志读取失败。请点击“刷新”重试。')
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

  const occurrences = new Map<string, number>()
  return <section className={css.panel} aria-label="运行日志">
    <div className={css.toolbar}>
      <div><h3>运行日志</h3><p>最近 200 条记录 · 点击查看详情</p></div>
      <div className={css.actions}>
        <Button variant="ghost" onClick={() => setPaused(value => !value)}>{paused ? '继续刷新' : '暂停刷新'}</Button>
        <Button variant="outline" disabled={busy} onClick={() => void refresh()}>刷新</Button>
      </div>
    </div>
    <p className={css.status} role="status">{snapshot ? `${paused ? '已暂停' : '每 2 秒刷新'} · 更新于 ${new Date(snapshot.updatedAt).toLocaleTimeString()}` : error ? '尚未读取到日志' : '正在读取运行日志…'}</p>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    {snapshot?.entries.length === 0 ? <p className={css.empty}>暂无运行记录。连接启动或收到请求后，日志会显示在这里。</p> : null}
    <ol className={css.entries} aria-label="运行日志记录" tabIndex={0}>
      {[...(snapshot?.entries ?? [])].reverse().map(entry => {
        const identity = entry.id ?? `${entry.time}-${entry.event}-${entry.details}`
        const occurrence = occurrences.get(identity) ?? 0
        occurrences.set(identity, occurrence + 1)
        const outcome = entry.outcome ?? (entry.level === 'error' ? 'failure' : 'info')
        const label = { success: '成功', failure: '失败', pending: '进行中', info: entry.level === 'warn' ? '提示' : '记录' }[outcome]
        return <li key={`${identity}-${occurrence}`} className={css.entry} data-outcome={outcome}>
          <details>
            <summary className={css.summary}>
              <time dateTime={entry.time}>{new Date(entry.time).toLocaleTimeString()}</time>
              <code title={entry.method ?? entry.event}>{entry.method ?? entry.event}</code>
              <span className={css.outcome}>{label}</span>
            </summary>
            <div className={css.detail}><p>{entry.event} · {entry.level.toUpperCase()}</p><pre>{entry.details}</pre></div>
          </details>
        </li>
      })}
    </ol>
  </section>
}
