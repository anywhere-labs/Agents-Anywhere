/**
 * OAuth2 Loopback Client & Device Auto-Registration Manager.
 *
 * Implements RFC 7636 (PKCE S256) + RFC 8252 (Loopback Interface Redirection)
 * for desktop OAuth authentication with the Agents Anywhere server.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import QRCode from 'qrcode'
import {
  type AppDownloadQrInfo,
  type ConnectorCredentials,
  type MobileLoginQrData,
  type MobileLoginStatusInfo,
  type UserAccount,
} from '../common/types.js'

export const DSH_OAUTH_CLIENT_ID = 'agents-anywhere-dsh'

export interface OAuthLoginResult {
  ok: boolean
  account?: UserAccount
  credentials?: ConnectorCredentials
  userToken?: string
  error?: string
}

export interface OAuthClientOptions {
  timeoutMs?: number
  openBrowser?: (url: string) => Promise<boolean>
  devicePath?: string
}

/** HTML page served by the loopback server on successful authorization */
const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agents Anywhere - 登录授权成功</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #f8fafc;
      color: #0f172a;
    }
    .card {
      background: white;
      padding: 3rem;
      border-radius: 1rem;
      box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
      text-align: center;
      max-width: 420px;
      margin: 1rem;
      border: 1px solid #e2e8f0;
    }
    .icon {
      width: 56px;
      height: 56px;
      background: #ecfdf5;
      color: #059669;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      margin-bottom: 1.25rem;
    }
    h1 { font-size: 1.35rem; margin: 0 0 0.5rem 0; font-weight: 600; }
    p { color: #64748b; font-size: 0.95rem; margin: 0; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✓</div>
    <h1>授权成功</h1>
    <p>已成功连接 Agents Anywhere 账号并完成设备绑定，现在可以关闭此页面返回 DSH Desktop。</p>
  </div>
</body>
</html>`

const ERROR_HTML = (msg: string) => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Agents Anywhere - 授权失败</title>
  <style>
    body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f8fafc; }
    .card { background: white; padding: 2.5rem; border-radius: 1rem; text-align: center; max-width: 400px; border: 1px solid #fee2e2; }
    h1 { color: #dc2626; font-size: 1.25rem; margin-bottom: 0.5rem; }
    p { color: #64748b; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>授权未完成</h1>
    <p>${msg}</p>
  </div>
</body>
</html>`

export class OAuthClient {
  private activeServer: Server | null = null
  private abortController: AbortController | null = null
  private readonly timeoutMs: number
  private readonly openBrowserFn: (url: string) => Promise<boolean>
  private readonly devicePath?: string | undefined

  constructor(options: OAuthClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 300_000 // 5 minutes
    this.openBrowserFn = options.openBrowser ?? defaultOpenBrowser
    this.devicePath = options.devicePath
  }

  /** Cancel any in-flight OAuth flow */
  cancel(): void {
    if (this.abortController !== null) {
      this.abortController.abort()
      this.abortController = null
    }
    if (this.activeServer !== null) {
      this.activeServer.close()
      this.activeServer = null
    }
  }

  /** Start the full OAuth2 login & device auto-registration flow */
  async startLoginFlow(serverUrl: string): Promise<OAuthLoginResult> {
    this.cancel()
    const normalizedServerUrl = serverUrl.trim().replace(/\/+$/, '')
    const abort = new AbortController()
    this.abortController = abort

    try {
      // 1. Generate PKCE & state
      const verifier = randomBytes(32).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const state = randomBytes(16).toString('hex')

      // 2. Start loopback HTTP server
      const { port, codePromise } = await this.startLoopbackServer(state, abort.signal)

      // 3. Construct OAuth authorize URL & launch browser
      const redirectUri = `http://127.0.0.1:${port}/callback`
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: DSH_OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        scope: 'profile',
      })

      // We direct the user to the web-next mobile-oauth page
      const authorizeUrl = `${normalizedServerUrl}/#mobile-oauth?${params.toString()}`
      const opened = await this.openBrowserFn(authorizeUrl)
      if (!opened) {
        this.cancel()
        return { ok: false, error: 'failed to open system browser' }
      }

      // 4. Await authorization code from browser callback
      const code = await codePromise

      // 5. Exchange code for user access token
      const tokenPayload = await this.exchangeCodeForToken({
        serverUrl: normalizedServerUrl,
        code,
        redirectUri,
        codeVerifier: verifier,
      })

      const userAccessToken = tokenPayload.access_token

      // 6. Fetch user profile
      const userMe = await this.fetchUserMe(normalizedServerUrl, userAccessToken)

      // 7. Auto-register current desktop device
      const deviceName = os.hostname() || 'DSH Desktop'
      const connectorResult = await this.createConnector({
        serverUrl: normalizedServerUrl,
        userToken: userAccessToken,
        deviceName,
      })

      const account: UserAccount = {
        userId: userMe.userId,
        ...(userMe.role !== undefined ? { role: userMe.role } : {}),
        avatar: userMe.avatar,
        serverUrl: normalizedServerUrl,
        loggedInAt: Date.now(),
      }

      const credentials: ConnectorCredentials = {
        serverUrl: normalizedServerUrl,
        connectorId: connectorResult.connector.id,
        connectorToken: connectorResult.connectorToken,
      }

      return {
        ok: true,
        account,
        credentials,
        userToken: userAccessToken,
      }
    } catch (error) {
      if (abort.signal.aborted) {
        return { ok: false, error: 'OAuth login cancelled' }
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.cancel()
    }
  }

  /** Helper to proxy create mobile login QR on AA server */
  async createMobileLoginQr(serverUrl: string, userToken: string): Promise<MobileLoginQrData> {
    const normalizedServerUrl = serverUrl.trim().replace(/\/+$/, '')
    const res = await fetch(`${normalizedServerUrl}/api/v2/auth/mobile-login/qr`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Failed to create mobile login QR (${res.status}): ${errText}`)
    }
    const data = (await res.json()) as {
      userId: string
      loginToken: string
      expiresAt: string
      serverTime: string
    }

    const qrPayload = JSON.stringify({
      type: 'agents-anywhere.mobile-login',
      version: 1,
      webUrl: normalizedServerUrl,
      userId: data.userId,
      loginToken: data.loginToken,
      expiresAt: data.expiresAt,
    })

    const qrImage = await QRCode.toDataURL(qrPayload, {
      width: 220,
      margin: 1,
      color: { dark: '#0f172a', light: '#ffffff' },
    })

    return {
      userId: data.userId,
      loginToken: data.loginToken,
      expiresAt: data.expiresAt,
      qrPayload,
      qrImage,
      serverTime: data.serverTime,
    }
  }

  /** Helper to generate mobile app download QR codes */
  async getAppDownloadQr(serverUrl: string): Promise<AppDownloadQrInfo> {
    const normalizedServerUrl = serverUrl.trim().replace(/\/+$/, '')
    const downloadUrl = `${normalizedServerUrl}/download`
    const iosQr = await QRCode.toDataURL(downloadUrl, { width: 160, margin: 1 })
    const androidQr = await QRCode.toDataURL(downloadUrl, { width: 160, margin: 1 })
    return { iosQr, androidQr }
  }

  /** Helper to poll mobile login status */
  async getMobileLoginStatus(
    serverUrl: string,
    userToken: string,
    loginToken: string,
  ): Promise<MobileLoginStatusInfo> {
    const normalizedServerUrl = serverUrl.trim().replace(/\/+$/, '')
    const res = await fetch(`${normalizedServerUrl}/api/v2/auth/mobile-login/status`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ loginToken }),
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Failed to get mobile login status (${res.status}): ${errText}`)
    }
    return (await res.json()) as MobileLoginStatusInfo
  }

  /** Helper to confirm/reject mobile login */
  async confirmMobileLogin(
    serverUrl: string,
    userToken: string,
    loginToken: string,
    approved: boolean,
  ): Promise<MobileLoginStatusInfo> {
    const normalizedServerUrl = serverUrl.trim().replace(/\/+$/, '')
    const res = await fetch(`${normalizedServerUrl}/api/v2/auth/mobile-login/confirm`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ loginToken, approved }),
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Failed to confirm mobile login (${res.status}): ${errText}`)
    }
    return (await res.json()) as MobileLoginStatusInfo
  }

  // ─── Internal helpers ───────────────────────────────────────────────────

  private startLoopbackServer(
    expectedState: string,
    signal: AbortSignal,
  ): Promise<{ port: number; codePromise: Promise<string> }> {
    return new Promise((resolveStart, rejectStart) => {
      let codeResolve: (code: string) => void
      let codeReject: (err: Error) => void
      const codePromise = new Promise<string>((res, rej) => {
        codeResolve = res
        codeReject = rej
      })

      const server = createServer((req, res) => {
        const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (reqUrl.pathname !== '/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('Not Found')
          return
        }

        const queryState = reqUrl.searchParams.get('state')
        const code = reqUrl.searchParams.get('code')
        const error = reqUrl.searchParams.get('error')
        const errorDescription = reqUrl.searchParams.get('error_description')

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(ERROR_HTML(`授权失败: ${error} (${errorDescription ?? ''})`))
          codeReject(new Error(`OAuth error: ${error} - ${errorDescription ?? ''}`))
          return
        }

        if (!queryState || queryState !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(ERROR_HTML('State 参数校验失败，可能存在跨站请求风险。'))
          codeReject(new Error('State mismatch'))
          return
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(ERROR_HTML('缺少 authorization code。'))
          codeReject(new Error('Missing authorization code in callback'))
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(SUCCESS_HTML)
        codeResolve(code)
      })

      this.activeServer = server

      const timer = setTimeout(() => {
        server.close()
        codeReject(new Error('OAuth authorization timed out'))
      }, this.timeoutMs)

      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        server.close()
        codeReject(new Error('OAuth authorization cancelled'))
      })

      server.on('error', (err) => {
        clearTimeout(timer)
        rejectStart(err)
      })

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (typeof addr === 'object' && addr !== null) {
          resolveStart({ port: addr.port, codePromise })
        } else {
          rejectStart(new Error('Failed to obtain loopback server port'))
        }
      })
    })
  }

  private async exchangeCodeForToken(params: {
    serverUrl: string
    code: string
    redirectUri: string
    codeVerifier: string
  }): Promise<{ access_token: string; token_type: string; expires_in: number; scope: string }> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      client_id: DSH_OAUTH_CLIENT_ID,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    })

    const res = await fetch(`${params.serverUrl}/api/v2/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`OAuth token exchange failed (${res.status}): ${errText}`)
    }

    return (await res.json()) as {
      access_token: string
      token_type: string
      expires_in: number
      scope: string
    }
  }

  private async fetchUserMe(serverUrl: string, accessToken: string): Promise<{
    userId: string
    role: string
    disabled: boolean
    avatar: string | null
  }> {
    const res = await fetch(`${serverUrl}/api/v2/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Failed to fetch user profile (${res.status}): ${errText}`)
    }
    return (await res.json()) as {
      userId: string
      role: string
      disabled: boolean
      avatar: string | null
    }
  }

  private async createConnector(params: {
    serverUrl: string
    userToken: string
    deviceName: string
  }): Promise<{
    connector: { id: string; name: string; userId: string }
    connectorToken: string
  }> {
    const stableId = getOrCreateStableDeviceId(this.devicePath)

    const res = await fetch(`${params.serverUrl}/api/v2/connectors`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: params.deviceName,
        connectorId: stableId,
        connector_id: stableId,
      }),
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Failed to create connector device (${res.status}): ${errText}`)
    }
    const data = (await res.json()) as {
      connector: { id: string; name: string; userId: string }
      connectorToken: string
    }
    saveStableDeviceId(data.connector.id, this.devicePath)
    return data
  }
}

/** Retrieve or generate a stable local connector ID persisted under ~/.dsh/agents-anywhere/device.json */
export function getOrCreateStableDeviceId(customPath?: string): string {
  if (customPath && existsSync(customPath)) {
    try {
      const data = JSON.parse(readFileSync(customPath, 'utf-8')) as { connectorId?: string }
      if (data && typeof data.connectorId === 'string' && data.connectorId.length > 0) {
        return data.connectorId
      }
    } catch {
      // ignore
    }
  }

  const possiblePaths = [
    path.join(os.homedir(), '.dsh', 'agents-anywhere', 'device.json'),
    path.join(os.homedir(), '.agents-anywhere', 'device.json'),
  ]
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      try {
        const data = JSON.parse(readFileSync(p, 'utf-8')) as { connectorId?: string }
        if (data && typeof data.connectorId === 'string' && data.connectorId.length > 0) {
          return data.connectorId
        }
      } catch {
        // ignore
      }
    }
  }

  // Check existing connector.json as fallback
  const cfgPath = path.join(os.homedir(), '.agents-anywhere', 'connector.json')
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { connectorId?: string }
      if (cfg && typeof cfg.connectorId === 'string' && cfg.connectorId.length > 0) {
        saveStableDeviceId(cfg.connectorId, customPath)
        return cfg.connectorId
      }
    } catch {
      // ignore
    }
  }

  // Generate new stable connector ID
  const newId = `conn_${randomBytes(8).toString('base64url')}`
  saveStableDeviceId(newId, customPath)
  return newId
}

export function saveStableDeviceId(connectorId: string, customPath?: string): void {
  const targetPaths = customPath
    ? [customPath]
    : [
        path.join(os.homedir(), '.dsh', 'agents-anywhere', 'device.json'),
        path.join(os.homedir(), '.agents-anywhere', 'device.json'),
      ]
  for (const targetPath of targetPaths) {
    try {
      const parent = path.dirname(targetPath)
      if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true })
      }
      writeFileSync(
        targetPath,
        JSON.stringify(
          {
            connectorId,
            deviceName: os.hostname() || 'DSH Desktop',
            createdAt: Date.now(),
          },
          null,
          2,
        ),
        'utf-8',
      )
    } catch {
      // ignore
    }
  }
}

/** Open URL in system default browser */
async function defaultOpenBrowser(url: string): Promise<boolean> {
  const platform = process.platform
  let command: string
  let args: string[]

  if (platform === 'darwin') {
    command = 'open'
    args = [url]
  } else if (platform === 'win32') {
    command = 'cmd.exe'
    args = ['/c', 'start', '', url]
  } else {
    command = 'xdg-open'
    args = [url]
  }

  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true })
      child.on('error', () => resolve(false))
      child.unref()
      resolve(true)
    } catch {
      resolve(false)
    }
  })
}
