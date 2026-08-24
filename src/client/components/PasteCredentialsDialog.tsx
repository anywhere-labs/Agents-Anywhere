import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from './Card.js'
import type { ConnectorActions } from '../stores/connector-store.js'

const LOCALE_NS = 'dsh-aa-connector'

interface PasteCredentialsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: ConnectorActions
  /** Invoked after a server URL is extracted and pairing starts, so the shell can reveal the pairing code. */
  onPairingStarted: () => void
  t: TranslateNS<typeof LOCALE_NS>
}

/**
 * Paste-credentials modal — mirrors desktop-next's "Paste credentials" flow.
 * Accepts a server address or pairing request, extracts the server URL, then
 * starts pairing. Full credential import is not part of this plugin's host
 * contract yet, so anything that isn't a server URL is rejected with a hint.
 */
export function PasteCredentialsDialog({ open, onOpenChange, actions, onPairingStarted, t }: PasteCredentialsDialogProps): JSX.Element | null {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setDraft('')
      setError(null)
      setBusy(false)
    }
  }, [open])

  if (!open) return null

  async function submit(): Promise<void> {
    const serverUrl = extractServerUrl(draft)
    if (serverUrl === null) {
      setError(draft.trim().length === 0 ? t('paste.error.empty') : t('paste.error.invalid'))
      return
    }
    setBusy(true)
    try {
      await actions.setServerUrl(serverUrl)
      await actions.startPairing()
      onOpenChange(false)
      onPairingStarted()
    } catch {
      setError(t('paste.error.invalid'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="dialog" aria-modal="true" style={backdropStyle} onClick={() => onOpenChange(false)}>
      <div style={sheetStyle} onClick={(event) => event.stopPropagation()}>
        <header style={sheetHeaderStyle}>
          <div style={titleColumnStyle}>
            <h3 style={titleStyle}>{t('paste.title')}</h3>
            <p style={subtitleStyle}>{t('paste.description')}</p>
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

        <div style={fieldBlockStyle}>
          <label style={labelStyle} htmlFor="aa-paste-credentials">{t('paste.label')}</label>
          <textarea
            id="aa-paste-credentials"
            rows={4}
            spellCheck={false}
            autoFocus
            value={draft}
            placeholder={t('paste.placeholder')}
            onChange={(event) => { setDraft(event.target.value); setError(null) }}
            style={textareaStyle}
          />
        </div>

        {error !== null && (
          <div style={errorBoxStyle}>{error}</div>
        )}

        <footer style={footerStyle}>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('action.cancel')}
          </Button>
          <Button variant="primary" onClick={() => { void submit() }} disabled={draft.trim().length === 0 || busy}>
            {t('paste.continue')}
          </Button>
        </footer>
      </div>
    </div>
  )
}

/** Extract the first `http(s)://` URL, or coerce a bare hostname into one. */
function extractServerUrl(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  const urlMatch = /https?:\/\/[^\s"'<>]+/i.exec(trimmed)
  if (urlMatch !== null) return urlMatch[0].replace(/\/+$/, '')
  // Accept a bare hostname (optionally with a path), e.g. "api.anywhere.app.com".
  const hostMatch = /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/[^\s]*)?$/i.exec(trimmed)
  if (hostMatch !== null) return `https://${trimmed.replace(/\/+$/, '')}`
  return null
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
  lineHeight: 1.5,
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

const fieldBlockStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const labelStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
}

const textareaStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  fontSize: 12,
  lineHeight: 1.5,
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  resize: 'vertical',
  outline: 'none',
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
