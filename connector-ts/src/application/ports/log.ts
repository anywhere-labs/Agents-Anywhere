/** The host's log sink. */
export type Log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
