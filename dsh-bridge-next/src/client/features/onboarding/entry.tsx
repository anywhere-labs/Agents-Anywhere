import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { Smartphone } from 'lucide-react'
import clsx from 'clsx'
import type { OnboardingHostApi } from '../../../contracts/index.js'
import { OnboardingSection } from './section.js'
import { AccountPanel } from './account-panel.js'
import { useOnboardingState } from './state.js'
import css from './entry.module.css'

export interface ConnectionEntryProps {
  wide: boolean
  host: OnboardingHostApi
}

export function ConnectionEntry({ wide, host }: ConnectionEntryProps) {
  const [open, setOpen] = useState(false)
  const state = useOnboardingState(host, open)
  const snapshot = state.snapshot
  const trigger = useRef<HTMLButtonElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  const close = useCallback(() => setOpen(false), [])

  // The official Modal portals to body. Keep focus in that dialog and restore
  // the application root and trigger when it closes or this fiber unloads.
  useEffect(() => {
    if (!open) return
    const dialog = content.current?.closest<HTMLElement>('[role="dialog"]')
    if (!dialog) return
    const appRoot = document.getElementById('root')
    const wasInert = appRoot?.hasAttribute('inert') ?? false
    appRoot?.setAttribute('inert', '')
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), summary, [tabindex="0"]',
    )).filter(element => {
      const collapsed = element.closest('details:not([open])')
      return !element.closest('[hidden], [inert]') && (!collapsed || element === collapsed.querySelector('summary'))
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
    dialog.addEventListener('keydown', onKeyDown)
    return () => {
      dialog.removeEventListener('keydown', onKeyDown)
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
          onClick={event => { trigger.current = event.currentTarget; setOpen(true) }}
        >
          {wide ? <span className={css.label}>手机连接</span> : null}
        </Button>
      </span>
    </Tooltip>
    <Modal
      open={open}
      onClose={close}
      title={snapshot?.account ? '已登录' : '登录到 Agents Anywhere'}
      closeLabel="关闭手机连接"
      {...(!snapshot?.account ? { description: '在所有设备间访问你的 Agent、会话和工作空间。' } : {})}
      className={clsx(css.dialog, snapshot?.account && css.accountDialog)}
      contentClassName={clsx(css.dialogContent)}
    >
      <div ref={content}>
        {snapshot?.account ? <AccountPanel key={`${snapshot.settings.apiBaseUrl}:${snapshot.account.userId}`} host={host} state={state} snapshot={snapshot} account={snapshot.account} />
          : <OnboardingSection host={host} state={state} />}
      </div>
    </Modal>
  </>
}
