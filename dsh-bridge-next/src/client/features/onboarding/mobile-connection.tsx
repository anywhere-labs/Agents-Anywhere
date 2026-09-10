import { useEffect, useId, useRef, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { Smartphone } from 'lucide-react'
import type { OnboardingHostApi } from '../../../contracts/index.js'
import type { MobileLoginSnapshot } from '../../../contracts/mobile.js'
import css from './mobile-connection.module.css'

export function MobileConnection({ host, disabled }: { host: OnboardingHostApi; disabled: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [qr, setQr] = useState<MobileLoginSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revision = useRef(0)
  const working = useRef(false)
  const alive = useRef(true)
  const id = useId()
  useEffect(() => { alive.current = true; return () => { alive.current = false; revision.current++ } }, [])

  const run = async (action: () => Promise<MobileLoginSnapshot>) => {
    if (working.current || disabled) return
    working.current = true
    const version = ++revision.current
    setBusy(true); setError(null)
    try {
      const next = await action()
      if (alive.current && revision.current === version) setQr(next)
    } catch (error) {
      if (alive.current && revision.current === version) setError(error instanceof Error ? error.message : '手机连接失败，请重试。')
    } finally { working.current = false; if (alive.current) setBusy(false) }
  }
  const generate = () => { setQr(null); void run(() => host.createMobileLogin()) }
  const status = qr?.status
  useEffect(() => {
    if (!expanded || busy || disabled || !qr || !['pending_scan', 'pending_web_confirm', 'approved'].includes(qr.status)) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const version = revision.current
    const poll = async () => {
      try {
        const next = await host.inspectMobileLogin(qr.id)
        if (!stopped && version === revision.current) { setQr(next); setError(null) }
      } catch (error) {
        if (!stopped && version === revision.current) setError(error instanceof Error ? error.message : '暂时无法读取手机连接状态。')
      }
      if (!stopped && version === revision.current) timer = setTimeout(() => void poll(), 1_600)
    }
    // Hide expired codes even if a status request is stalled by a lost network.
    const expiry = setTimeout(() => {
      stopped = true; clearTimeout(timer)
      setQr(current => current?.id === qr.id ? { ...current, status: 'expired', qrImage: null } : current)
    }, Math.max(0, Date.parse(qr.expiresAt) - Date.now()))
    void poll()
    return () => { stopped = true; clearTimeout(timer); clearTimeout(expiry) }
  }, [host, expanded, busy, disabled, qr?.id, status])

  const message = status === 'pending_web_confirm' ? `${qr?.deviceName || '一台手机'}请求连接此账号`
    : status === 'approved' ? '已确认，正在完成手机登录…'
      : status === 'consumed' ? '手机已连接'
        : status === 'rejected' ? '已拒绝此次连接'
          : status === 'expired' ? '二维码已过期' : '使用手机端扫描二维码'
  return <div className={css.connection}>
    <Button variant="outline" className={css.button} icon={<Smartphone size={16} />}
      disabled={disabled || busy} aria-expanded={expanded} aria-controls={id}
      onClick={() => { if (expanded) { setExpanded(false); revision.current++ } else { setExpanded(true); generate() } }}>
      {expanded ? '收起二维码' : '手机连接'}
    </Button>
    {expanded ? <div id={id} className={css.content} aria-busy={busy}>
      {busy ? <p className={css.status} role="status"><StateDot state="ongoing" />正在处理…</p> : <>
        {qr?.qrImage && status === 'pending_scan' ? <img className={css.qr} src={qr.qrImage} width={256} height={256} alt="手机连接二维码" /> : null}
        {qr ? <p className={css.status} role="status" aria-live="polite">
          <StateDot state={status === 'consumed' ? 'done' : status === 'pending_scan' || status === 'approved' ? 'ongoing' : 'warning'} />{message}
        </p> : null}
        {status === 'pending_scan' ? <p className={css.hint}>有效至 {new Date(qr!.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p> : null}
        {status === 'pending_web_confirm' ? <div className={css.actions}>
          <Button variant="outline" disabled={disabled} onClick={() => void run(() => host.confirmMobileLogin(qr!.id, false))}>拒绝连接</Button>
          <Button variant="primary" disabled={disabled} onClick={() => void run(() => host.confirmMobileLogin(qr!.id, true))}>确认连接</Button>
        </div> : null}
      </>}
      {error ? <p className={css.error} role="alert">{error}</p> : null}
      {!busy && (!qr || status === 'expired' || status === 'rejected' || status === 'consumed' || error) ?
        <Button variant="ghost" disabled={disabled} onClick={generate}>{status === 'consumed' ? '连接另一台手机' : '重新生成二维码'}</Button> : null}
    </div> : null}
  </div>
}
