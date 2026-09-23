import { translateMessage, type Translate } from '../../locales.js'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OnboardingHostApi } from '../../../contracts/index.js'
import type { ConnectorLogEntry } from '../../../contracts/logs.js'
import css from './bridge-logs-panel.module.css'

export function ConnectorLogsPanel({ t, host }: { t: Translate; host: OnboardingHostApi }) {
  const [entries, setEntries] = useState<ConnectorLogEntry[]>([])
  const [older, setOlder] = useState(false)
  const [paused, setPaused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const current = useRef<ConnectorLogEntry[]>([])
  const loading = useRef(false)
  const generation = useRef(0)
  const initialized = useRef(false)
  const scroll = useRef<{ height: number; top: number } | 'bottom' | null>(null)
  const refresh = useCallback(async (mode: 'latest' | 'older' = 'latest') => {
    if (loading.current) return
    loading.current = true
    setBusy(true)
    const version = generation.current
    const previous = current.current
    const query = mode === 'older' && previous.length ? { before: previous[0]!.id } : initialized.current && previous.length ? { after: previous.at(-1)!.id } : {}
    try {
      let page = await host.readConnectorLogs(query)
      if (version !== generation.current) return
      const reset = initialized.current && (page.newestId === null || (previous.length > 0 && page.newestId < previous.at(-1)!.id))
      if (reset && page.newestId !== null) page = await host.readConnectorLogs()
      if (version !== generation.current) return
      const element = viewport.current
      if (mode === 'older' && element && !reset) scroll.current = { height: element.scrollHeight, top: element.scrollTop }
      else if (!initialized.current || reset || (element && element.scrollHeight - element.clientHeight - element.scrollTop < 48)) scroll.current = 'bottom'
      const merged = reset || !initialized.current ? page.entries : mode === 'older' ? [...page.entries, ...previous] : [...previous, ...page.entries]
      const next = [...new Map(merged.map(entry => [entry.id, entry])).values()]
        .filter(entry => page.oldestId !== null && entry.id >= page.oldestId).slice(-10_000)
      current.current = next
      initialized.current = true
      setEntries(next)
      setOlder(page.oldestId !== null && next.length > 0 && next[0]!.id > page.oldestId)
      setError(null)
    } catch { if (version === generation.current) setError('Connector 日志读取失败，请重试。') }
    finally { if (version === generation.current) { loading.current = false; setBusy(false) } }
  }, [host])
  useLayoutEffect(() => {
    const element = viewport.current
    if (element && scroll.current) element.scrollTop = scroll.current === 'bottom' ? element.scrollHeight : scroll.current.top + element.scrollHeight - scroll.current.height
    scroll.current = null
  }, [entries])
  useEffect(() => {
    loading.current = false
    void refresh()
    return () => { generation.current++ }
  }, [refresh])
  useEffect(() => {
    if (paused) return
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh() }, 2000)
    return () => clearInterval(timer)
  }, [paused, refresh])
  return <section className={css.panel} aria-label={t('Connector 日志')}>
    <div className={css.toolbar}>
      <div><h3>{t('Connector 日志')}</h3><p>{t('最多保留 10,000 行 · 每次加载 200 行 · 向上滚动查看更早记录')}</p></div>
      <div className={css.actions}>
        <Button variant="ghost" onClick={() => setPaused(value => !value)}>{paused ? t('继续刷新') : t('暂停刷新')}</Button>
        <Button variant="outline" disabled={busy} onClick={() => void refresh()}>{t('刷新')}</Button>
      </div>
    </div>
    <p className={css.status} role="status">{busy ? t('正在读取…') : t('{status} · 已显示 {count} 行', { status: paused ? t('已暂停刷新') : t('每 2 秒刷新'), count: entries.length })}</p>
    {error ? <p className={css.error} role="alert">{translateMessage(t, error)}</p> : null}
    <div ref={viewport} className={css.terminal} tabIndex={0} aria-label={t('Connector 终端输出')}
      onScroll={event => { if (event.currentTarget.scrollTop <= 24 && older) void refresh('older') }}>
      {older ? <Button variant="ghost" disabled={busy} onClick={() => void refresh('older')}>{t('加载更早的 200 行')}</Button> : null}
      {!entries.length && !busy ? <p className={css.empty}>{t('暂无 Connector 日志。启动后，环境准备和运行输出会显示在这里。')}</p> : null}
      {entries.map(entry => <div key={entry.id} className={css.terminalLine}><time dateTime={entry.time}>{new Date(entry.time).toLocaleTimeString(t('locale.code'))}</time>{' '}{entry.text}</div>)}
    </div>
  </section>
}
