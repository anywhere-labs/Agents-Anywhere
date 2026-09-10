import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BridgeStatus } from '../../../contracts/bridge-status.js'
import css from './bridge-status.module.css'

export function BridgeStatusNotice({ status, busy, error, onRestart, onLogs }: {
  status: BridgeStatus | undefined, busy: boolean, error: string | null,
  onRestart: () => void, onLogs: () => void,
}) {
  if (!status || status.state === 'ready') return null
  const failed = status.state === 'failed' || status.state === 'unavailable'
  return <section className={css.notice} data-failed={failed} aria-label="本机连接状态">
    <div role={failed ? 'alert' : 'status'}>
      <strong>{status.message}</strong>
      {status.hint ? <p>{status.hint}</p> : null}
    </div>
    {failed ? <div className={css.actions}>
      {status.canRetry ? <Button variant="outline" disabled={busy} onClick={onRestart}>{busy ? '正在重试…' : '尝试重启'}</Button> : null}
      <Button variant="ghost" onClick={onLogs}>查看运行日志</Button>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>
}
