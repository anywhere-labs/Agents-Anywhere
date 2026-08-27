import { describe, expect, it, vi, afterEach } from 'vitest'
import { OAuthClient, DSH_OAUTH_CLIENT_ID } from '../src/manager/oauth-client.js'
import { ConnectorCoordinator } from '../src/manager/connector-coordinator.js'

describe('OAuthClient', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runs loopback OAuth PKCE flow, exchanges token, and registers device', async () => {
    let capturedUrl = ''

    const originalFetch = globalThis.fetch
    const client = new OAuthClient({
      timeoutMs: 10_000,
      devicePath: '/tmp/test-device-oauth.json',
      openBrowser: async (url: string) => {
        capturedUrl = url
        // Simulate browser authorization redirect
        const parsed = new URL(url.replace('/#mobile-oauth', ''))
        const redirectUri = parsed.searchParams.get('redirect_uri')!
        const state = parsed.searchParams.get('state')!

        // Hit the loopback server callback directly using originalFetch
        setTimeout(async () => {
          await originalFetch(`${redirectUri}?code=auth_code_123&state=${state}`)
        }, 50)
        return true
      },
    })

    // Mock global fetch for token exchange, user me, and connector creation
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes('/api/v2/oauth/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'user_jwt_token_abc',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'profile',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/api/v2/auth/me')) {
        return new Response(
          JSON.stringify({
            userId: 'alice',
            role: 'member',
            disabled: false,
            avatar: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/api/v2/connectors')) {
        if (init?.method === 'GET' || !init?.method) {
          return new Response(JSON.stringify({ connectors: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(
          JSON.stringify({
            connector: { id: 'conn_999', name: 'MacBook Pro', userId: 'alice' },
            connectorToken: 'tok_secret_888',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return originalFetch(input, init)
    })

    const result = await client.startLoginFlow('https://anywhere.example.com')

    expect(result.ok).toBe(true)
    expect(result.account?.userId).toBe('alice')
    expect(result.credentials?.connectorId).toBe('conn_999')
    expect(result.credentials?.connectorToken).toBe('tok_secret_888')
    expect(capturedUrl).toContain('client_id=agents-anywhere-dsh')
    expect(capturedUrl).toContain('code_challenge_method=S256')
  })

  it('handles mobile QR login creation and status polling', async () => {
    const client = new OAuthClient()

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/v2/auth/mobile-login/qr')) {
        return new Response(
          JSON.stringify({
            userId: 'alice',
            loginToken: 'mob_token_123',
            expiresAt: '2026-08-27T10:00:00Z',
            serverTime: '2026-08-27T09:58:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/api/v2/auth/mobile-login/status')) {
        return new Response(
          JSON.stringify({
            status: 'approved',
            userId: 'alice',
            deviceName: 'iPhone 16',
            expiresAt: '2026-08-27T10:00:00Z',
            requestedAt: '2026-08-27T09:58:10Z',
            approvedAt: '2026-08-27T09:58:20Z',
            serverTime: '2026-08-27T09:58:25Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('Not found', { status: 404 })
    })

    const qr = await client.createMobileLoginQr('https://anywhere.example.com', 'user_token_xyz')
    expect(qr.userId).toBe('alice')
    expect(qr.loginToken).toBe('mob_token_123')
    expect(qr.qrPayload).toContain('agents-anywhere.mobile-login')

    const status = await client.getMobileLoginStatus('https://anywhere.example.com', 'user_token_xyz', 'mob_token_123')
    expect(status.status).toBe('approved')
    expect(status.deviceName).toBe('iPhone 16')
  })
})

describe('ConnectorCoordinator OAuth integration', () => {
  it('updates state snapshot through startOAuthLogin, logout, and mobile QR helpers', async () => {
    const mockOAuthClient = new OAuthClient({
      openBrowser: async () => true,
    })

    vi.spyOn(mockOAuthClient, 'startLoginFlow').mockResolvedValue({
      ok: true,
      account: {
        userId: 'bob',
        role: 'admin',
        avatar: null,
        serverUrl: 'https://anywhere.example.com',
        loggedInAt: Date.now(),
      },
      credentials: {
        serverUrl: 'https://anywhere.example.com',
        connectorId: 'conn_bob_1',
        connectorToken: 'tok_bob_1',
      },
      userToken: 'user_jwt_bob',
    })

    const coordinator = new ConnectorCoordinator({
      oauthClient: mockOAuthClient,
      configPath: '/tmp/test-connector-oauth.json',
    })

    // Mock saveCredentials on coordinator to prevent actual subprocess launch
    vi.spyOn(coordinator, 'saveCredentials').mockResolvedValue({ ok: true })

    const res = await coordinator.startOAuthLogin('https://anywhere.example.com')
    expect(res.ok).toBe(true)

    const snapshot = coordinator.getSnapshot()
    expect(snapshot.account?.userId).toBe('bob')
    expect(snapshot.oauth.status).toBe('success')

    // Logout
    vi.spyOn(coordinator, 'clearCredentials').mockResolvedValue({ ok: true })
    const logoutRes = await coordinator.logout()
    expect(logoutRes.ok).toBe(true)
    expect(coordinator.getSnapshot().account).toBeNull()
    expect(coordinator.getSnapshot().oauth.status).toBe('idle')

    await coordinator.dispose()
  })
})
