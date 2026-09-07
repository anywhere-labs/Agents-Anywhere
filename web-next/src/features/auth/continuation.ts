const KEY = 'agents-anywhere.auth-continuation'
const flows = new Set(['mobile-oauth', 'desktop-oauth', 'plugin-oauth', 'onboarding'])

export function authFlowHash(hash: string): string | null {
  if (!hash.startsWith('#') || hash.length > 8192) return null
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? ''
  return flows.has(path) ? hash : null
}

export function rememberAuthFlow(hash: string, storage: Pick<Storage, 'setItem'>): void {
  const flow = authFlowHash(hash)
  if (flow) { try { storage.setItem(KEY, flow) } catch { /* Current hash still works without storage. */ } }
}

export function takeAuthFlow(hash: string, storage: Pick<Storage, 'getItem' | 'removeItem'>): string | null {
  let saved: string | null = null
  try { saved = storage.getItem(KEY); storage.removeItem(KEY) } catch { /* Storage may be blocked. */ }
  return authFlowHash(hash) ?? (saved ? authFlowHash(saved) : null)
}

export function clearAuthFlow(storage: Pick<Storage, 'removeItem'>): void {
  try { storage.removeItem(KEY) } catch { /* Best effort. */ }
}
