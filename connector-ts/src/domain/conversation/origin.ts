/**
 * Who sent a user message when it was not a person typing it (protocol 1.2 `MessageAuthor`): an Agent acting through
 * the collaboration tools, or a supervision wake. Conversation keeps and shows it; no rule depends on it.
 */
export interface MessageAuthor {
  readonly kind: 'agent' | 'supervision'
  /** The supervisor session the Agent acts for. */
  readonly sessionId?: string | null
  readonly deviceId?: string | null
  readonly supervisionId?: string | null
}

export function parseMessageAuthor(value: unknown): MessageAuthor | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.kind !== 'agent' && record.kind !== 'supervision') return null
  const text = (key: string): string | null => (typeof record[key] === 'string' && (record[key] as string) !== '' ? (record[key] as string) : null)
  return { kind: record.kind, sessionId: text('sessionId'), deviceId: text('deviceId'), supervisionId: text('supervisionId') }
}
