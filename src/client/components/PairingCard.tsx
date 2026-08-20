import type { CSSProperties } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Card, KeyValueRow, StatusPill, buttonGhost, buttonPrimary, buttonSecondary, inputBase } from './Card.js'
import type { ConnectorActions, ConnectorState, PairingStatus } from '../stores/connector-store.js'

const LOCALE_NS = 'dsh-aa-connector'

interface PairingCardProps {
  state: ConnectorState
  actions: ConnectorActions
  t: TranslateNS<typeof LOCALE_NS>
}

const PAIRING_CODE_LENGTH = 6

/**
 * Pairing flow: server URL input, start/stop pairing, code + claim URL with a
 * live countdown, and the destructive clear-credentials action.
 */
export function PairingCard({ state, actions, t }: PairingCardProps): JSX.Element {
  const [serverDraft, setServerDraft] = useState(state.pairing.serverUrl)
  useEffect(() => { setServerDraft(state.pairing.serverUrl) }, [state.pairing.serverUrl])

  const remainingSeconds = useCountdown(state.pairing.expiresAt)

  const busy = state.pairing.status === 'starting' || state.pairing.status === 'waiting'

  return (
    <Card title={t('pairing.title')} description={t('pairing.description')}>
      <div style={serverRowStyle}>
        <label style={serverLabelStyle} htmlFor="aa-server-url">{t('pairing.server.label')}</label>
        <input
          id="aa-server-url"
          type="url"
          spellCheck={false}
          autoComplete="off"
          value={serverDraft}
          placeholder={t('pairing.server.placeholder')}
          onChange={(event) => setServerDraft(event.target.value)}
          onBlur={() => actions.setServerUrl(serverDraft)}
          disabled={busy}
          style={{ ...inputBase, flex: 1, opacity: busy ? 0.6 : 1 }}
        />
      </div>

      <StatusPill tone={pairingToneOf(state.pairing.status)}>
        {pairingStatusLabel(state.pairing.status, t)}
      </StatusPill>

      {state.pairing.status === 'waiting' && state.pairing.code !== null && (
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

      {state.pairing.status === 'waiting' && state.pairing.claimUrl !== null && (
        <KeyValueRow
          label={t('pairing.claim.label')}
          value={
            <span style={claimRowStyle}>
              <code style={codeStyle}>{state.pairing.claimUrl}</code>
              <button
                type="button"
                style={buttonGhost}
                onClick={() => copyToClipboard(state.pairing.claimUrl, t)}
              >
                {t('action.copy')}
              </button>
            </span>
          }
          hint={t('pairing.claim.hint')}
        />
      )}

      {state.pairing.status === 'error' && state.pairing.lastError !== null && (
        <div style={errorBoxStyle}>{state.pairing.lastError}</div>
      )}

      <div style={actionsRowStyle}>
        {state.pairing.status === 'idle' || state.pairing.status === 'cancelled' || state.pairing.status === 'error' ? (
          <button type="button" style={buttonPrimary} onClick={() => actions.startPairing()}>
            {t('pairing.start')}
          </button>
        ) : null}

        {state.pairing.status === 'claimed' ? (
          <button type="button" style={buttonSecondary} onClick={() => actions.startPairing()}>
            {t('pairing.repair')}
          </button>
        ) : null}

        {busy && (
          <button type="button" style={buttonSecondary} onClick={() => actions.cancelPairing()}>
            {t('pairing.cancel')}
          </button>
        )}

        {state.device !== null && (
          <button type="button" style={buttonGhost} onClick={() => actions.clearCredentials()}>
            {t('pairing.clear')}
          </button>
        )}
      </div>

      {state.device !== null && (
        <Card title={t('pairing.device.title')}>
          <KeyValueRow label={t('pairing.device.name')} value={state.device.deviceName} />
          <KeyValueRow
            label={t('pairing.device.id')}
            value={<code style={codeStyle}>{state.device.deviceId}</code>}
          />
          <KeyValueRow
            label={t('pairing.device.paired')}
            value={formatTime(state.device.pairedAt)}
          />
        </Card>
      )}
    </Card>
  )
}

function useCountdown(expiresAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (expiresAt === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [expiresAt])
  return useMemo(() => {
    if (expiresAt === null) return null
    const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000))
    return remaining > 0 ? remaining : null
  }, [expiresAt, now])
}

function pairingToneOf(status: PairingStatus): 'neutral' | 'info' | 'warn' | 'success' | 'error' {
  switch (status) {
    case 'idle':
    case 'cancelled':
      return 'neutral'
    case 'starting':
      return 'info'
    case 'waiting':
      return 'warn'
    case 'claimed':
      return 'success'
    case 'error':
      return 'error'
  }
}

function pairingStatusLabel(status: PairingStatus, t: PairingCardProps['t']): string {
  switch (status) {
    case 'idle':
      return t('pairing.status.idle')
    case 'starting':
      return t('pairing.status.starting')
    case 'waiting':
      return t('pairing.status.waiting')
    case 'claimed':
      return t('pairing.status.claimed')
    case 'cancelled':
      return t('pairing.status.cancelled')
    case 'error':
      return t('pairing.status.error')
  }
}

function formatPairingCode(code: string): string {
  if (code.length <= PAIRING_CODE_LENGTH) return code.toUpperCase()
  return code.toUpperCase().slice(0, PAIRING_CODE_LENGTH)
}

function copyToClipboard(value: string | null, t: PairingCardProps['t']): void {
  if (value === null) return
  if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
    void navigator.clipboard.writeText(value).catch(() => undefined)
  }
  void t
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

const serverRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
}

const serverLabelStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-text-secondary, #6b6b6b)',
  minWidth: 80,
}

const codeBlockStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '14px 16px',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-warning-soft, rgba(255, 167, 38, 0.14))',
  border: '1px dashed var(--dsw-alias-border-warning, rgba(255, 167, 38, 0.36))',
}

const codeLabelStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-text-warning, #b25e09)',
  fontWeight: 500,
}

const codeStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 18,
  letterSpacing: 4,
  fontWeight: 600,
  color: 'var(--dsw-alias-text-primary, #1f1f1f)',
  padding: '4px 8px',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-surface-1, #ffffff)',
  alignSelf: 'flex-start',
}

const countdownStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-text-warning, #b25e09)',
}

const claimRowStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
}

const actionsRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
}

const errorBoxStyle: CSSProperties = {
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-error, rgba(198, 40, 40, 0.32))',
  background: 'var(--dsw-alias-bg-error-soft, rgba(198, 40, 40, 0.12))',
  color: 'var(--dsw-alias-text-error, #c62828)',
  fontSize: 12,
  lineHeight: 1.5,
}