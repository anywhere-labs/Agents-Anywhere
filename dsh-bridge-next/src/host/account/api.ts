import { OAUTH_CLIENT_ID, type AccountProfile } from '../../contracts/index.js'
import type { MobileLoginStatus } from '../../contracts/mobile.js'

export interface MobileQr {
  userId: string
  loginToken: string
  expiresAt: string
  serverTime: string
}
export interface MobileStatus {
  status: MobileLoginStatus
  userId?: string | null
  deviceName?: string | null
}

export interface Account extends AccountProfile {
  apiBaseUrl: string
  accessToken: string
  expiresAt: number
}

/** Only display fields cross the public RPC boundary; avatars follow the server's data-image contract. */
export function publicProfile(user: AccountProfile): AccountProfile {
  return {
    userId: user.userId,
    displayName: user.displayName?.trim() || user.userId,
    email: typeof user.email === 'string' ? user.email : null,
    avatar: typeof user.avatar === 'string' && user.avatar.length <= 256 * 1024
      && /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(user.avatar) ? user.avatar : null,
  }
}

export interface Device {
  id: string
  name: string
  userId: string
  status: string
}

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(status === 401 ? '登录已失效，请重新登录。' : `服务请求失败（HTTP ${status}），请重试。`)
  }
}

export class AccountApi {
  constructor(readonly baseUrl: string, private readonly fetcher: typeof fetch = fetch) {}

  private async request<T>(path: string, options: RequestInit, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(20_000)
    const response = await this.fetcher(`${this.baseUrl}/api/v2${path}`, {
      ...options,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok) throw new ApiError(response.status)
    return await response.json() as T
  }

  async exchange(code: string, verifier: string, redirectUri: string, signal: AbortSignal): Promise<Account> {
    const token = await this.request<{ access_token: string; expires_in: number }>('/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: OAUTH_CLIENT_ID, code, code_verifier: verifier, redirect_uri: redirectUri }),
    }, signal)
    if (!token.access_token || !Number.isFinite(token.expires_in)) throw new Error('授权服务没有返回有效凭据。')
    const user = await this.me(token.access_token, signal)
    return { ...user, apiBaseUrl: this.baseUrl, accessToken: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 }
  }

  async me(token: string, signal?: AbortSignal): Promise<AccountProfile> {
    const user = await this.request<AccountProfile>('/auth/me', { headers: this.auth(token) }, signal)
    if (!user.userId) throw new Error('无法确认当前账号。')
    return publicProfile(user)
  }

  async device(token: string, id: string, signal?: AbortSignal): Promise<Device> {
    const result = await this.request<{ connector: Device }>(`/connectors/${encodeURIComponent(id)}`, { headers: this.auth(token) }, signal)
    if (result.connector?.id !== id) throw new Error('设备响应无效。')
    return result.connector
  }

  async devices(token: string, signal: AbortSignal): Promise<Device[]> {
    const result = await this.request<{ connectors: Device[] }>('/connectors', { headers: this.auth(token) }, signal)
    if (!Array.isArray(result.connectors) || result.connectors.some(device => !device
      || typeof device.id !== 'string' || !device.id || typeof device.userId !== 'string'
      || typeof device.name !== 'string')) throw new Error('设备列表响应无效，请重试。')
    return result.connectors
  }

  async register(token: string, name: string, installationId: string, signal: AbortSignal): Promise<{ connector: Device; connectorToken: string }> {
    const result = await this.request<{ connector: Device; connectorToken: string }>('/connectors', {
      method: 'POST', headers: { ...this.auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, connectorKind: 'cli', installationId }),
    }, signal)
    if (!result.connector?.id || !result.connectorToken) throw new Error('设备注册没有返回有效凭据。')
    return result
  }

  async verifyConnector(id: string, token: string, signal: AbortSignal): Promise<boolean> {
    try {
      await this.request('/connector/auth', { method: 'POST', headers: { Authorization: `Connector ${id}:${token}` } }, signal)
      return true
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return false
      throw error
    }
  }

  async renewConnector(token: string, id: string, signal: AbortSignal): Promise<string> {
    const result = await this.request<{ connector: Device; connectorToken: string }>(`/connectors/${encodeURIComponent(id)}/revoke`, { method: 'POST', headers: this.auth(token) }, signal)
    if (result.connector?.id !== id || !result.connectorToken) throw new Error('无法恢复设备凭据。')
    return result.connectorToken
  }

  createMobileQr(token: string, signal: AbortSignal): Promise<MobileQr> {
    return this.request('/auth/mobile-login/qr', { method: 'POST', headers: this.auth(token) }, signal)
  }

  mobileStatus(token: string, loginToken: string, signal: AbortSignal): Promise<MobileStatus> {
    return this.request('/auth/mobile-login/status', {
      method: 'POST', headers: { ...this.auth(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ loginToken }),
    }, signal)
  }

  confirmMobile(token: string, loginToken: string, approved: boolean, signal: AbortSignal): Promise<MobileStatus> {
    return this.request('/auth/mobile-login/confirm', {
      method: 'POST', headers: { ...this.auth(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ loginToken, approved }),
    }, signal)
  }

  private auth(token: string): Record<string, string> { return { Authorization: `Bearer ${token}` } }
}
