export type NativeOAuthKind = 'mobile' | 'desktop' | 'plugin'
export interface NativeOAuthParams {
  response_type: string
  client_id: string
  redirect_uri: string
  code_challenge: string
  code_challenge_method: string
  scope: string
  state?: string
}

const clients = {
  mobile: { id: 'agents-anywhere-mobile', redirect: 'agents-anywhere://oauth/callback' },
  desktop: { id: 'agents-anywhere-desktop', redirect: 'agents-anywhere-desktop://oauth/callback' },
  plugin: { id: 'agents-anywhere-dsh-plugin', redirect: '' },
}

export function isPluginRedirect(uri: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/oauth\/callback$/.exec(uri)
  return Boolean(match && match[0] === uri && Number(match[1]) >= 1024 && Number(match[1]) <= 65535)
}

export function readNativeOAuthParams(params: { get(name: string): string | null }, kind: NativeOAuthKind): NativeOAuthParams | null {
  const client = clients[kind]
  const redirect = params.get('redirect_uri') ?? ''
  const challenge = params.get('code_challenge') ?? ''
  const state = params.get('state') ?? ''
  if (params.get('response_type') !== 'code' || params.get('client_id') !== client.id) return null
  if (kind === 'plugin' ? !isPluginRedirect(redirect) : redirect !== client.redirect) return null
  const method = params.get('code_challenge_method') || 'S256'
  if (!challenge || method !== 'S256') return null
  if (kind === 'plugin' && (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || !/^[A-Za-z0-9_-]{32,128}$/.test(state))) return null
  return {
    response_type: 'code', client_id: client.id, redirect_uri: redirect,
    code_challenge: challenge, code_challenge_method: method, scope: params.get('scope') || '',
    ...(state ? { state } : {}),
  }
}
