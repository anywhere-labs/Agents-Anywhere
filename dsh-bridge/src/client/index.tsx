/** DSH Desktop client entry for the Agents Anywhere bridge status surface. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { useState, type CSSProperties } from 'react'

/** Client services required by the status entry. */
export const inject = ['slots', 'sessions']

/** Register a visible AA Bridge status control in the DSH Desktop shell. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'agents-anywhere-bridge',
    order: 80,
  }, (props: StatusProps) => <AgentsAnywhereBridgeStatus ctx={ctx} {...props} />))
}

interface StatusProps {
  useSessions<T>(selector: (state: SessionListState) => T): T
}

function AgentsAnywhereBridgeStatus({ useSessions }: StatusProps & { ctx: ClientContext }): JSX.Element {
  const [open, setOpen] = useState(false)
  const sessionId = useSessions(state => state.current)
  return (
    <aside style={shellStyle} data-agents-anywhere-bridge="">
      {open && (
        <section style={panelStyle} role="status" aria-label="Agents Anywhere Bridge 状态">
          <strong style={titleStyle}>Agents Anywhere Bridge</strong>
          <span style={copyStyle}>SDK 服务已由 DSH Desktop 托管</span>
          <span style={hintStyle}>Agents Anywhere Connector 通过本机端点连接此进程。</span>
          <span style={hintStyle}>{sessionId === undefined ? '当前未选择会话。' : `当前会话：${sessionId}`}</span>
        </section>
      )}
      <button
        type="button"
        style={buttonStyle}
        aria-expanded={open}
        aria-label="打开 Agents Anywhere Bridge 状态"
        onClick={() => { setOpen(value => !value) }}
      >
        <span style={dotStyle} aria-hidden="true" />
        AA Bridge
      </button>
    </aside>
  )
}

const shellStyle: CSSProperties = {
  position: 'absolute',
  right: 18,
  bottom: 18,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 8,
  color: 'var(--dsw-alias-text-primary, #f5f5f5)',
  fontFamily: 'inherit',
}

const panelStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: 280,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '14px 16px',
  border: '1px solid var(--dsw-alias-border-l2, #454545)',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-overlay, #262626)',
  boxShadow: '0 12px 36px rgba(0, 0, 0, 0.28)',
}

const titleStyle: CSSProperties = { fontSize: 14, lineHeight: 1.4 }
const copyStyle: CSSProperties = { fontSize: 13, color: 'var(--dsw-alias-text-success, #7ee787)' }
const hintStyle: CSSProperties = { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-text-secondary, #b5b5b5)' }

const buttonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '9px 13px',
  border: '1px solid var(--dsw-alias-border-l2, #454545)',
  borderRadius: 999,
  background: 'var(--dsw-alias-button-floating-fill, #2f2f2f)',
  color: 'inherit',
  font: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
  boxShadow: '0 6px 20px rgba(0, 0, 0, 0.22)',
}

const dotStyle: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: '#3fb950',
  boxShadow: '0 0 0 3px rgba(63, 185, 80, 0.14)',
}
