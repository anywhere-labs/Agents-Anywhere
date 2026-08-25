import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from './Card.js'
import type { ConnectorActions } from '../stores/connector-store.js'
import type { ConnectorCredentials } from '../../common/types.js'

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
 * Accepts either full connector credentials (base64 payload or a
 * `start --server-url … --connector-id … --connector-token …` command) or a
 * server address / pairing request; the former saves the credential, the
 * latter starts the pairing flow.
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
    const parsed = parseCredentialsText(draft)
    if (parsed === null) {
      setError(draft.trim().length === 0 ? t('paste.error.empty') : t('paste.error.invalid'))
      return
    }
    setBusy(true)
    try {
      if (parsed.kind === 'credentials') {
        await actions.saveCredentials(parsed.credentials)
        onOpenChange(false)
      } else {
        await actions.setServerUrl(parsed.server)
        await actions.startPairing()
        onOpenChange(false)
        onPairingStarted()
      }
    } catch (error) {
      // Show the real failure (e.g. connector.start rejected) rather than the
      // generic "unrecognized" message — parse failures return earlier.
      setError(error instanceof Error && error.message ? error.message : t('paste.error.invalid'))
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

type ParsedPaste =
  | { kind: 'credentials'; credentials: ConnectorCredentials }
  | { kind: 'pair'; server: string }

/** Parse a pasted credential payload / command / URL into an action. */
function parseCredentialsText(text: string): ParsedPaste | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null

  // 1. Base64 connector-credentials payload (web console format).
  const payload = parseBase64Credentials(trimmed)
  if (payload === 'invalid') return null
  if (payload !== null) return { kind: 'credentials', credentials: payload }

  // 2. Shell command: `start --server-url … --connector-id … --connector-token …`
  //    or `pair <url>`.
  const parts = splitShell(trimmed)
  const commandIndex = parts.findIndex((part) => part === 'start' || part === 'pair' || part === 'login')
  if (commandIndex >= 0) {
    const command = parts[commandIndex]
    const arg = (name: string): string | undefined => {
      const index = parts.indexOf(name)
      return index >= 0 ? parts[index + 1] : undefined
    }
    if (command === 'start') {
      const serverUrl = (arg('--server-url') ?? '').replace(/\/+$/, '')
      const connectorId = arg('--connector-id') ?? ''
      const connectorToken = arg('--connector-token') ?? ''
      if (serverUrl && connectorId && connectorToken) {
        return { kind: 'credentials', credentials: { serverUrl, connectorId, connectorToken } }
      }
      return null
    }
    const server = arg('--server-url') ?? parts[commandIndex + 1] ?? ''
    if (server) return { kind: 'pair', server }
    return null
  }

  // 3. Plain URL or bare hostname.
  const server = extractServerUrl(trimmed)
  if (server !== null) return { kind: 'pair', server }

  return null
}

/** Decode a base64 `agents-anywhere.connector-credentials` payload. */
function parseBase64Credentials(input: string): ConnectorCredentials | null | 'invalid' {
  const compact = input.replace(/\s/g, '')
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null
  try {
    const binary = atob(compact)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
    const serverUrl = typeof payload.serverUrl === 'string' ? payload.serverUrl.trim().replace(/\/+$/, '') : ''
    const connectorId = typeof payload.connectorId === 'string' ? payload.connectorId.trim() : ''
    const connectorToken = typeof payload.connectorToken === 'string' ? payload.connectorToken.trim() : ''
    if (
      payload.type !== 'agents-anywhere.connector-credentials'
      || payload.version !== 1
      || !/^https?:\/\//i.test(serverUrl)
      || !connectorId
      || !connectorToken
    ) {
      return payload.type === 'agents-anywhere.connector-credentials' ? 'invalid' : null
    }
    return { serverUrl, connectorId, connectorToken }
  } catch {
    return null
  }
}

/** Split a shell-style command line into tokens, honoring single/double quotes. */
function splitShell(input: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? ''
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) parts.push(current)
  return parts
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
