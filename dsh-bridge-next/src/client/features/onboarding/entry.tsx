import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { Download, MessageCircle, Smartphone, Star } from 'lucide-react'
import clsx from 'clsx'
import type { OnboardingHostApi } from '../../../contracts/index.js'
import { OnboardingSection } from './section.js'
import { AccountPanel } from './account-panel.js'
import { useOnboardingState } from './state.js'
import css from './entry.module.css'
import { SettingsPanel } from './settings-panel.js'
import { BridgeStatusNotice } from './bridge-status.js'
import { BridgeLogsPanel } from './bridge-logs-panel.js'

const homeLinks = [
  { label: '下载 Agents Anywhere 桌面端', url: 'https://www.agents-anywhere.com', icon: Download },
  { label: '加入内测交流群', url: 'https://github.com/anywhere-labs/Agents-Anywhere#%E4%BA%A4%E6%B5%81%E4%B8%8E%E5%8F%8D%E9%A6%88', icon: MessageCircle },
  { label: '去 GitHub 点 Star', url: 'https://github.com/anywhere-labs/Agents-Anywhere', icon: Star },
] as const

const tabs = ['connection', 'settings', 'logs'] as const
const tabLabels = { connection: '登录和连接', settings: '设置', logs: '运行日志' }

export interface ConnectionEntryProps {
  wide: boolean
  host: OnboardingHostApi
}

export function ConnectionEntry({ wide, host }: ConnectionEntryProps) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<typeof tabs[number]>('connection')
  const tabId = useId()
  const state = useOnboardingState(host, open)
  const snapshot = state.snapshot
  const standalone = snapshot?.desktop.status === 'absent'
  const ownershipError = standalone && snapshot?.ownership && snapshot.ownership.status !== 'owned' ? snapshot.ownership.message || '暂时无法检查本机 Connector 状态，请稍后重试。' : null
  const showLogin = standalone && !snapshot.account && tab === 'connection'
  const detectionError = snapshot?.desktop.status === 'error' ? snapshot.desktop.message : !snapshot ? state.readError : null
  const detectionMessage = detectionError ?? (snapshot?.desktop.status === 'installed'
    ? '已安装 Agents Anywhere 桌面端。请打开桌面端完成连接设置。' : '正在检查连接方式…')
  const trigger = useRef<HTMLButtonElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  const close = useCallback(() => {
    // Official Modals each listen for Escape; a nested reset confirmation must
    // close first, leaving the connection panel and its edits in place.
    if (document.querySelectorAll('[role="dialog"]').length > 1) return
    setOpen(false)
  }, [])

  // The official Modal portals to body. Keep focus in that dialog and restore
  // the application root and trigger when it closes or this fiber unloads.
  useEffect(() => {
    if (!open) return
    const dialog = content.current?.closest<HTMLElement>('[role="dialog"]')
    if (!dialog) return
    const appRoot = document.getElementById('root')
    const wasInert = appRoot?.hasAttribute('inert') ?? false
    appRoot?.setAttribute('inert', '')
    const activeDialog = () => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).at(-1) ?? dialog
    const focusable = () => Array.from(activeDialog().querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), summary, [tabindex="0"]',
    )).filter(element => {
      const collapsed = element.closest('details:not([open])')
      return element.tabIndex >= 0 && !element.closest('[hidden], [inert]') && (!collapsed || element === collapsed.querySelector('summary'))
    })
    focusable()[0]?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const targets = focusable()
      const first = targets[0]
      const last = targets.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus()
      }
    }
    let lastFocus: HTMLElement | null = null
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && dialog.contains(event.target)) lastFocus = event.target
    }
    const observer = new MutationObserver(() => {
      const wasCovered = dialog.hasAttribute('inert')
      const covered = activeDialog() !== dialog
      dialog.toggleAttribute('inert', covered)
      if (wasCovered && !covered && lastFocus?.isConnected) lastFocus.focus()
    })
    observer.observe(document.body, { childList: true })
    document.addEventListener('focusin', onFocus)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      observer.disconnect()
      dialog.removeAttribute('inert')
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('keydown', onKeyDown)
      appRoot?.toggleAttribute('inert', wasInert)
      if (trigger.current?.isConnected) trigger.current.focus()
    }
  }, [open])

  return <>
    <Tooltip label="手机连接" disabled={wide || open} delayMs={500}>
      <span className={clsx(css.trigger, !wide && css.rail)}>
        <Button
          variant="ghost"
          className={css.button}
          icon={<Smartphone size={16} strokeWidth={1.5} />}
          aria-label="手机连接"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={event => { trigger.current = event.currentTarget; state.prepareOpen(); setTab('connection'); setOpen(true) }}
        >
          {wide ? <span className={css.label}>手机连接</span> : null}
        </Button>
      </span>
    </Tooltip>
    <Modal
      open={open}
      onClose={close}
      title={standalone ? 'Agents Anywhere' : '手机连接'}
      closeLabel="关闭手机连接"
      className={clsx(css.dialog, standalone ? css.wordmarkDialog : css.accountDialog, tab === 'logs' && css.logsDialog)}
      contentClassName={clsx(css.dialogContent)}
    >
      <div ref={content}>
          <div className={css.tabs} role="tablist" aria-label="连接管理">
            {tabs.map(value => <Button key={value} variant={tab === value ? 'outline' : 'ghost'}
              role="tab" id={`${tabId}-${value}`} aria-selected={tab === value} aria-controls={`${tabId}-panel`}
              tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                  : (tabs.indexOf(value) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
                const next = tabs[index]!
                setTab(next); document.getElementById(`${tabId}-${next}`)?.focus()
              }}>{tabLabels[value]}</Button>)}
          </div>
          <BridgeStatusNotice status={snapshot?.bridge} busy={state.busy} error={state.error}
            onRestart={() => void state.run(() => host.restartBridge())} onLogs={() => setTab('logs')} />
          <div id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${tab}`}>
        {tab === 'logs' ? <BridgeLogsPanel host={host} /> : ownershipError ? <p className={css.placeholder} role="alert">{ownershipError}</p> : !standalone ? <>
          <p className={css.placeholder} role={detectionError ? 'alert' : 'status'}>{detectionMessage}</p>
          {state.error ? <p className={css.placeholder} role="alert">{state.error}</p> : null}
          {detectionError
            ? <Button variant="outline" disabled={state.busy} onClick={() => void state.run(state.refresh)}>重新检查</Button>
            : <Button variant="primary" disabled={state.busy} onClick={() => void state.run(() => host.openDesktop())}>打开 Agents Anywhere</Button>}
        </> : <>
            {tab === 'settings' ? <SettingsPanel host={host} state={state} snapshot={snapshot} onConnection={() => setTab('connection')} />
              : snapshot.account ? <AccountPanel key={`${snapshot.settings.apiBaseUrl}:${snapshot.account.userId}`} host={host} state={state} snapshot={snapshot} account={snapshot.account} />
                : <>
                  {showLogin ? <p className={css.loginDescription}>在所有设备间访问你的 Agent、会话和工作空间。</p> : null}
                  <OnboardingSection host={host} state={state} />
                </>}
        </>}
            {tab === 'connection' ? <nav className={css.homeLinks} aria-label="Agents Anywhere 相关链接">
              {homeLinks.map(({ label, url, icon: Icon }) => <Button key={url} variant="outline"
                icon={<Icon size={16} strokeWidth={1.5} />} onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}>
                {label}
              </Button>)}
            </nav> : null}
          </div>
      </div>
    </Modal>
  </>
}
