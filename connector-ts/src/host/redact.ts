// Credential redaction before anything is written to a log, the rules of v2 connector/mesh/log_redaction.py; shared
// with Desktop and the DSH plugin (04-connector.md §8), so it stays a dependency-free module.

const KEY = /\bmk_[A-Za-z0-9_-]+/gu
// Bearer/Basic values are unambiguous scheme tokens; `Connector` is only a scheme next to an authorization field
// because it is a common word in log messages.
const SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/giu
const FIELD = /((?:\\?")?(?:authorization|connectorToken|access[_-]?token|refresh[_-]?token|password|secret|api[_-]?key|key)(?:\\?")?\s*[:=]\s*(?:\\?")?(?:(?:Bearer|Basic|Connector)\s+)?)([^"\\\s,}]+)/giu

export function redact(value: string): string {
  return value
    .replace(KEY, '[REDACTED]')
    .replace(SCHEME, (_match, scheme: string) => `${scheme} [REDACTED]`)
    .replace(FIELD, (_match, prefix: string) => `${prefix}[REDACTED]`)
}
