import type { CSSProperties, ReactNode } from 'react'

export interface CardProps {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
}

/** Plain bordered surface shared by every settings card. */
export function Card({ title, description, actions, children }: CardProps): JSX.Element {
  return (
    <section style={cardStyle}>
      {(title !== undefined || actions !== undefined) && (
        <header style={headerStyle}>
          <div style={titleColumnStyle}>
            {title !== undefined && <h3 style={titleStyle}>{title}</h3>}
            {description !== undefined && <p style={descriptionStyle}>{description}</p>}
          </div>
          {actions !== undefined && <div style={actionsStyle}>{actions}</div>}
        </header>
      )}
      <div style={bodyStyle}>{children}</div>
    </section>
  )
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: '18px 20px',
  borderRadius: 12,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-surface-1)',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
}

const titleColumnStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--dsw-alias-text-primary)',
}

const descriptionStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-text-secondary)',
}

const actionsStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
}

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--dsw-alias-text-primary)',
}

export interface StatusPillProps {
  tone: 'neutral' | 'success' | 'warn' | 'error' | 'info'
  children: ReactNode
}

export function StatusPill({ tone, children }: StatusPillProps): JSX.Element {
  const palette = PILL_TONE[tone]
  return (
    <span style={{ ...pillStyle, ...palette }}>
      <span aria-hidden="true" style={dotStyle} />
      {children}
    </span>
  )
}

const PILL_TONE: Record<StatusPillProps['tone'], { color: string; background: string; border: string }> = {
  neutral: {
    color: 'var(--dsw-alias-text-secondary)',
    background: 'var(--dsw-alias-bg-surface-2)',
    border: 'var(--dsw-alias-border-l2)',
  },
  success: {
    color: 'var(--dsw-alias-text-success)',
    background: 'var(--dsw-alias-bg-success-soft)',
    border: 'var(--dsw-alias-border-success)',
  },
  warn: {
    color: 'var(--dsw-alias-text-warning)',
    background: 'var(--dsw-alias-bg-warning-soft)',
    border: 'var(--dsw-alias-border-warning)',
  },
  error: {
    color: 'var(--dsw-alias-text-error)',
    background: 'var(--dsw-alias-bg-error-soft)',
    border: 'var(--dsw-alias-border-error)',
  },
  info: {
    color: 'var(--dsw-alias-text-info)',
    background: 'var(--dsw-alias-bg-info-soft)',
    border: 'var(--dsw-alias-border-info)',
  },
}

const pillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 10px',
  borderRadius: 999,
  border: '1px solid',
  fontSize: 12,
  fontWeight: 500,
  lineHeight: 1.4,
}

const dotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'currentColor',
}

export interface KeyValueRowProps {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
}

export function KeyValueRow({ label, value, hint }: KeyValueRowProps): JSX.Element {
  return (
    <div style={rowStyle}>
      <span style={rowLabelStyle}>{label}</span>
      <span style={rowValueStyle}>{value}</span>
      {hint !== undefined && <span style={rowHintStyle}>{hint}</span>}
    </div>
  )
}

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '140px 1fr',
  gap: 12,
  alignItems: 'baseline',
}

const rowLabelStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-text-secondary)',
}

const rowValueStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--dsw-alias-text-primary)',
  fontVariantNumeric: 'tabular-nums',
  wordBreak: 'break-all',
}

const rowHintStyle: CSSProperties = {
  gridColumn: '2 / 3',
  fontSize: 11,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-text-tertiary)',
}

export const buttonPrimary: CSSProperties = {
  padding: '7px 14px',
  fontSize: 13,
  fontWeight: 500,
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-primary)',
  background: 'var(--dsw-alias-button-primary-fill)',
  color: 'var(--dsw-alias-text-on-primary)',
  cursor: 'pointer',
  font: 'inherit',
}

export const buttonSecondary: CSSProperties = {
  ...buttonPrimary,
  background: 'var(--dsw-alias-bg-surface-2)',
  border: '1px solid var(--dsw-alias-border-l2)',
  color: 'var(--dsw-alias-text-primary)',
}

export const buttonGhost: CSSProperties = {
  ...buttonSecondary,
  border: '1px solid transparent',
  background: 'transparent',
}

export const inputBase: CSSProperties = {
  padding: '7px 10px',
  fontSize: 13,
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-surface-1)',
  color: 'var(--dsw-alias-text-primary)',
  font: 'inherit',
  outline: 'none',
}

export const codeSurface: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  padding: '1px 6px',
  borderRadius: 4,
  background: 'var(--dsw-alias-bg-surface-2)',
  color: 'var(--dsw-alias-text-primary)',
}