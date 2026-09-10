/** The backend is already normalized by Host; both runtimes use the same Web routing convention. */
export function resolveOAuthWebOrigin(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl)
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.port === '8000') url.port = '5174'
  return url.origin
}

export function resolveWebAppUrl(apiBaseUrl: string): string {
  return `${resolveOAuthWebOrigin(apiBaseUrl)}/#/`
}

export function resolveOnboardingUrl(apiBaseUrl: string, connectorId: string, flowId: string): string {
  const url = new URL(`${resolveOAuthWebOrigin(apiBaseUrl)}/`)
  url.hash = `/onboarding?${new URLSearchParams({ source: 'dsh-plugin', connectorId, flowId })}`
  return url.href
}
