import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, codeSurface, inputBase } from './Card.js'
import type { ConnectorActions, ConnectorState } from '../stores/connector-store.js'

const LOCALE_NS = 'dsh-aa-connector'

interface PairingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  state: ConnectorState
  actions: ConnectorActions
  t: TranslateNS<typeof LOCALE_NS>
}

const PAIRING_CODE_LENGTH = 6
const COUNTDOWN_TICK_MS = 1000

/**
 * Modal pairing flow. Hosts the server URL input + 6-digit code / claim URL
 * countdown, with start / cancel actions wired to the live Host.
 */
export function PairingDialog({ open, onOpenChange, state, actions, t }: PairingDialogProps): JSX.Element | null {
  const [serverDraft, setServerDraft] = useState(state.pairing.serverUrl)
  const [copyState, setCopyState] = useState<null | 'code' | 'claim'>(null)

  useEffect(() => {
    setServerDraft(state.pairing.serverUrl)
  }, [state.pairing.serverUrl])

  if (!open) return null
  const remainingSeconds = computeRemainingSeconds(state.pairing.expiresAt)

  async function copy(value: string, kind: 'code' | 'claim'): Promise<void> {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return
    await navigator.clipboard.writeText(value).catch(() => undefined)
    setCopyState(kind)
    window.setTimeout(() => setCopyState(null), 1200)
  }

  return (
    <div role="dialog" aria-modal="true" style={backdropStyle} onClick={() => onOpenChange(false)}>
      <div style={sheetStyle} onClick={(event) => event.stopPropagation()}>
        <header style={sheetHeaderStyle}>
          <div style={titleColumnStyle}>
            <h3 style={titleStyle}>{state.pairing.code ? t('pairing.code.label') : t('pairing.title')}</h3>
            <p style={subtitleStyle}>{t('pairing.description')}</p>
          </div>
          <button
            type="button"
            style={closeButtonStyle}
            onClick={() => onOpenChange(false)}
            aria-label={t('action.close')}
          >
            ×
          </button>
        </header>

        {!state.pairing.code && (
          <div style={serverBlockStyle}>
            <label style={labelStyle} htmlFor="aa-server-input">{t('pairing.server.label')}</label>
            <input
              id="aa-server-input"
              type="url"
              spellCheck={false}
              autoComplete="off"
              value={serverDraft}
              placeholder={t('pairing.server.placeholder')}
              onChange={(event) => setServerDraft(event.target.value)}
              onBlur={() => { void actions.setServerUrl(serverDraft) }}
              disabled={state.pairing.status === 'starting' || state.pairing.status === 'waiting'}
              style={{ ...inputBase, width: '100%' }}
            />
          </div>
        )}

        {state.pairing.code !== null && (
          <div style={codeBlockStyle}>
            <span style={codeLabelStyle}>{t('pairing.code.label')}</span>
            <code style={codeStyle}>{formatPairingCode(state.pairing.code)}</code>
            <span style={countdownStyle}>
              {remainingSeconds !== null
                ? t('pairing.expiresIn', { seconds: remainingSeconds })
                : t('pairing.expired')}
            </span>
          </div>
        )}

        {state.pairing.claimUrl !== null && (
          <div style={claimBlockStyle}>
            <span style={labelStyle}>{t('pairing.claim.label')}</span>
            <div style={claimRowStyle}>
              <code style={codeSurfaceStyle}>{state.pairing.claimUrl}</code>
              <Button variant="ghost" onClick={() => { void copy(state.pairing.claimUrl ?? '', 'claim') }}>
                {copyState === 'claim' ? '✓' : t('action.copy')}
              </Button>
            </div>
            <p style={hintStyle}>{t('pairing.claim.hint')}</p>
          </div>
        )}

        {state.pairing.lastError !== null && (
          <div style={errorBoxStyle}>{state.pairing.lastError}</div>
        )}

        <footer style={footerStyle}>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('action.cancel')}
          </Button>
          {state.pairing.status === 'waiting' || state.pairing.status === 'starting' ? (
            <Button variant="secondary" onClick={() => { void actions.cancelPairing() }}>
              {t('pairing.cancel')}
            </Button>
          ) : state.pairing.code !== null ? (
            <Button variant="primary" onClick={() => { void actions.startPairing() }}>
              {t('pairing.repair')}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => { void actions.startPairing() }} disabled={serverDraft.trim().length === 0}>
              {t('pairing.start')}
            </Button>
          )}
          {state.pairing.code !== null && (
            <Button variant="ghost" onClick={() => { void copy(state.pairing.code ?? '', 'code') }}>
              {copyState === 'code' ? '✓' : t('action.copy')}
            </Button>
          )}
        </footer>
      </div>
    </div>
  )
}

function computeRemainingSeconds(expiresAt: number | null): number | null {
  if (expiresAt === null) return null
  const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  return remaining > 0 ? remaining : null
}

function formatPairingCode(code: string): string {
  if (code.length <= PAIRING_CODE_LENGTH) return code.toUpperCase()
  return code.toUpperCase().slice(0, PAIRING_CODE_LENGTH)
}

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: 16,
}

const sheetStyle: CSSProperties = {
  width: '100%',
  maxWidth: 480,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 12,
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  boxShadow: '0 24px 60px rgba(0, 0, 0, 0.3)',
}

const sheetHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
}

const titleColumnStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 0,
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}

const subtitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
}

const closeButtonStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  fontSize: 22,
  lineHeight: 1,
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)',
}

const serverBlockStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const labelStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
}

const codeBlockStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 14,
  borderRadius: 10,
  background: 'var(--dsw-alias-state-warn-tertiary)',
  border: '1px dashed var(--dsw-alias-state-warn-primary)',
}

const codeLabelStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-state-warn-primary)',
  fontWeight: 500,
}

const codeStyle: CSSProperties = {
  ...codeSurface,
  fontSize: 22,
  letterSpacing: 4,
  alignSelf: 'flex-start',
  padding: '6px 12px',
}

const countdownStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-state-warn-primary)',
}

const claimBlockStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const claimRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
}

const codeSurfaceStyle: CSSProperties = {
  ...codeSurface,
  fontSize: 12,
  wordBreak: 'break-all',
  flex: 1,
  minWidth: 0,
}

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: 11,
  color: 'var(--dsw-alias-label-tertiary)',
}

const errorBoxStyle: CSSProperties = {
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-state-error-primary)',
  background: 'var(--dsw-alias-state-error-secondary)',
  color: 'var(--dsw-alias-state-error-primary)',
  fontSize: 12,
  lineHeight: 1.5,
}

const footerStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
}

// Mark `COUNTDOWN_TICK_MS` as intentionally retained for future interval use.
void COUNTDOWN_TICK_MS