import { translateMessage, type Translate } from '../../locales.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OnboardingHostApi } from '../../../contracts/index.js'
import type { RuntimeLogEntry, RuntimeLogPage, RuntimeLogSource } from '../../../contracts/logs.js'
import { ConnectorLogsPanel } from './connector-logs-panel.js'
import css from './bridge-logs-panel.module.css'

type LogViewMode = 'all' | RuntimeLogSource | 'bootstrap'

export function BridgeLogsPanel({ t, host }: { t: Translate; host: OnboardingHostApi }) {
  const [view, setView] = useState<LogViewMode>('all')
  return <div>
    <div className={css.sources} role="group" aria-label={t('日志来源')}>
      <Button variant={view === 'all' ? 'primary' : 'outline'} aria-pressed={view === 'all'} onClick={() => setView('all')}>{t('全部')}</Button>
      <Button variant={view === 'plugin' ? 'primary' : 'outline'} aria-pressed={view === 'plugin'} onClick={() => setView('plugin')}>{t('插件')}</Button>
      <Button variant={view === 'bridge' ? 'primary' : 'outline'} aria-pressed={view === 'bridge'} onClick={() => setView('bridge')}>Bridge</Button>
      <Button variant={view === 'connector' ? 'primary' : 'outline'} aria-pressed={view === 'connector'} onClick={() => setView('connector')}>Connector</Button>
      <Button variant={view === 'bootstrap' ? 'primary' : 'outline'} aria-pressed={view === 'bootstrap'} onClick={() => setView('bootstrap')}>{t('启动前诊断')}</Button>
    </div>
    {view === 'bootstrap'
      ? <ConnectorLogsPanel t={t} host={host} />
      : <UnifiedRuntimeLogView t={t} host={host} source={view} onOpenBootstrap={() => setView('bootstrap')} />}
  </div>
}

function mergeBySeq(entries: RuntimeLogEntry[]): RuntimeLogEntry[] {
  const map = new Map<number, RuntimeLogEntry>()
  for (const entry of entries) map.set(entry.seq, entry)
  return [...map.values()].sort((a, b) => a.seq - b.seq).slice(-10_000)
}

function UnifiedRuntimeLogView({
  t,
  host,
  source,
  onOpenBootstrap,
}: {
  t: Translate
  host: OnboardingHostApi
  source: 'all' | RuntimeLogSource
  onOpenBootstrap: () => void
}) {
  const [entries, setEntries] = useState<RuntimeLogEntry[]>([])
  const [pageMeta, setPageMeta] = useState<Pick<RuntimeLogPage, 'available' | 'updatedAt' | 'logsPath'> | null>(null)
  const [older, setOlder] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [busy, setBusy] = useState(false)
  const current = useRef<RuntimeLogEntry[]>([])
  const olderRef = useRef(false)
  const lastSeqRef = useRef(0)
  const initialized = useRef(false)
  const loading = useRef(false)
  const generation = useRef(0)

  const filterSource: RuntimeLogSource | null = source === 'all' ? null : source

  const refresh = useCallback(async (mode: 'latest' | 'older' | 'reset' = 'latest') => {
    if (loading.current && mode !== 'reset') return
    if (mode === 'older' && (!initialized.current || current.current.length === 0 || !olderRef.current)) return
    loading.current = true
    setBusy(true)
    const version = generation.current
    const previous = mode === 'reset' ? [] : current.current
    const query = mode === 'older' && previous.length > 0
      ? { source: filterSource, beforeSeq: previous[0]!.seq, limit: 200 }
      : initialized.current && mode === 'latest' && previous.length > 0
        ? { source: filterSource, afterSeq: previous.at(-1)!.seq, limit: 200 }
        : { source: filterSource, limit: 200 }

    try {
      let page = await host.readRuntimeLogs(query)
      if (version !== generation.current) return

      if (!page.available) {
        current.current = []
        olderRef.current = false
        lastSeqRef.current = 0
        initialized.current = false
        setEntries([])
        setOlder(false)
        setPageMeta({ available: false, updatedAt: page.updatedAt, logsPath: page.logsPath })
        setError(null)
        return
      }

      const nextLastSeq = page.lastSeq ?? 0
      const seqRegressed = initialized.current && (
        nextLastSeq < lastSeqRef.current ||
        (previous.length > 0 && nextLastSeq < previous.at(-1)!.seq)
      )
      if (seqRegressed) {
        page = await host.readRuntimeLogs({ source: filterSource, limit: 200 })
        if (version !== generation.current) return
      }

      const isInitialOrReset = !initialized.current || mode === 'reset' || seqRegressed || previous.length === 0
      const merged = isInitialOrReset
        ? mergeBySeq(page.items)
        : mode === 'older'
          ? mergeBySeq([...page.items, ...previous])
          : mergeBySeq([...previous, ...page.items])

      const nextOlder = isInitialOrReset || mode === 'older'
        ? page.hasMoreBefore
        : olderRef.current || (merged.length > 0 && previous.length > 0 && merged[0]!.seq > previous[0]!.seq)

      current.current = merged
      olderRef.current = nextOlder
      lastSeqRef.current = page.lastSeq ?? 0
      initialized.current = true
      setEntries(merged)
      setOlder(nextOlder)
      setPageMeta({ available: true, updatedAt: page.updatedAt, logsPath: page.logsPath })
      setError(null)
    } catch {
      if (version === generation.current) setError('运行日志读取失败。请点击“刷新”重试。')
    } finally {
      if (version === generation.current) {
        loading.current = false
        setBusy(false)
      }
    }
  }, [host, filterSource])

  useEffect(() => {
    generation.current++
    loading.current = false
    current.current = []
    olderRef.current = false
    lastSeqRef.current = 0
    initialized.current = false
    setEntries([])
    setOlder(false)
    setPageMeta(null)
    setError(null)
    void refresh('reset')
    return () => { generation.current++ }
  }, [refresh])

  useEffect(() => {
    if (paused) return
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh('latest') }, 2000)
    return () => clearInterval(timer)
  }, [paused, refresh])

  const sourceLabel = (entrySource: RuntimeLogSource) =>
    entrySource === 'plugin' ? t('插件') : entrySource === 'bridge' ? 'Bridge' : 'Connector'

  return <section className={css.panel} aria-label={t('运行日志')}>
    <div className={css.toolbar}>
      <div><h3>{t('运行日志')}</h3><p>{t('插件、Bridge 与 Connector 统一运行日志 · 点击查看详情')}</p></div>
      <div className={css.actions}>
        <Button variant="ghost" onClick={() => setPaused(value => !value)}>{paused ? t('继续刷新') : t('暂停刷新')}</Button>
        <Button variant="outline" disabled={busy} onClick={() => void refresh('latest')}>{t('刷新')}</Button>
      </div>
    </div>
    <p className={css.status} role="status">
      {pageMeta
        ? `${t('{status} · 更新于 {time}', { status: paused ? t('已暂停') : t('每 2 秒刷新'), time: new Date(pageMeta.updatedAt).toLocaleTimeString(t('locale.code')) })} · ${t('{status} · 已显示 {count} 条', { status: source === 'all' ? t('全部') : sourceLabel(source), count: entries.length })}`
        : error ? t('尚未读取到日志') : t('正在读取运行日志…')}
    </p>
    {error ? <p className={css.error} role="alert">{translateMessage(t, error)}</p> : null}
    {pageMeta && !pageMeta.available ? <div className={css.unavailable} role="status">
      <p>{t('统一运行日志服务尚未就绪。Connector 启动并建立本机 RPC 连接后，插件、Bridge 与 Connector 日志将在此统一展示。')}</p>
      <Button variant="outline" onClick={onOpenBootstrap}>{t('查看启动前诊断')}</Button>
    </div> : null}
    {pageMeta?.available && entries.length === 0 ? <p className={css.empty}>{t('暂无运行记录。连接启动或收到请求后，日志会显示在这里。')}</p> : null}
    {pageMeta?.available ? <>
      <ol className={css.entries} aria-label={t('运行日志记录')} tabIndex={0}>
        {[...entries].reverse().map(entry => {
          const outcome = entry.outcome ?? (entry.level === 'error' ? 'failure' : 'info')
          const label = { success: t('成功'), failure: t('失败'), pending: t('进行中'), info: entry.level === 'warn' ? t('提示') : t('记录') }[outcome]
          const srcLabel = sourceLabel(entry.source)
          const headline = entry.method
            ? (entry.message && entry.message !== entry.method ? `${entry.method} · ${entry.message}` : entry.method)
            : entry.message
          const hasStructuredDetails = Boolean(entry.details && entry.details !== '{}')
          const detailText = hasStructuredDetails
            ? (entry.message ? `${entry.message}\n${entry.details}` : entry.details)
            : entry.message
          return <li key={entry.seq} className={css.entry} data-outcome={outcome} data-source={entry.source} data-level={entry.level}>
            <details>
              <summary className={css.summary}>
                <time dateTime={entry.time}>{new Date(entry.time).toLocaleTimeString(t('locale.code'))}</time>
                <span className={css.sourceBadge} data-source={entry.source}>{srcLabel}</span>
                <span className={css.levelBadge} data-level={entry.level}>{entry.level.toUpperCase()}</span>
                <code title={headline}>{headline}</code>
                <span className={css.outcome}>{label}</span>
              </summary>
              <div className={css.detail}>
                <p>#{entry.seq} · {srcLabel} · {entry.name} · {entry.level.toUpperCase()}</p>
                {detailText ? <pre>{detailText}</pre> : null}
                {entry.exception ? <pre className={css.exception}>{entry.exception}</pre> : null}
              </div>
            </details>
          </li>
        })}
      </ol>
      {older ? <div className={css.loadOlder}><Button variant="ghost" disabled={busy} onClick={() => void refresh('older')}>{t('加载更早的 200 条')}</Button></div> : null}
    </> : null}
  </section>
}

