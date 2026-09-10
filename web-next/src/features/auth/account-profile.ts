export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isValidEmail(email: string): boolean {
  const value = normalizeEmail(email)
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export function isValidDisplayName(displayName: string): boolean {
  const length = displayName.trim().length
  return length >= 1 && length <= 64
}

export function accountDisplayName(account: { displayName?: string | null; email?: string | null }): string {
  return account.displayName?.trim() || account.email || "—"
}
