import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OAUTH_CLIENT_ID, type FlowStage } from '../../contracts/index.js'

type Progress = { stage: FlowStage; message: string; redirectUrl?: string }

export class LoopbackFlow {
  readonly id = randomUUID()
  readonly state = randomBytes(32).toString('base64url')
  readonly verifier = randomBytes(48).toString('base64url')
  private readonly progressPath = `/onboarding/${randomBytes(32).toString('base64url')}`
  private readonly server = createServer((req, res) => this.handle(req, res))
  private origin = ''
  private consumed = false
  private progress: Progress = { stage: 'authorizing', message: '正在等待登录授权…' }
  private expiry: ReturnType<typeof setTimeout> | undefined
  private shutdown: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly onCode: (code: string) => void, private readonly onCancel: (message: string) => void) {}

  get redirectUri(): string { return `${this.origin}/oauth/callback` }
  get progressUrl(): string { return `${this.origin}${this.progressPath}` }

  async listen(timeoutMs = 10 * 60_000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error)
      this.server.once('error', fail)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', fail)
        resolve()
      })
    })
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    this.expiry = setTimeout(() => this.onCancel('本次登录已超时，请回到插件重试。'), timeoutMs)
    this.expiry.unref()
  }

  authorizationUrl(webBaseUrl: string): string {
    const url = new URL(`${webBaseUrl}/`)
    url.hash = `/plugin-oauth?${new URLSearchParams({
      response_type: 'code', client_id: OAUTH_CLIENT_ID, redirect_uri: this.redirectUri,
      code_challenge: createHash('sha256').update(this.verifier).digest('base64url'),
      code_challenge_method: 'S256', scope: 'profile', state: this.state,
    })}`
    return url.href
  }

  update(progress: Progress): void {
    this.progress = progress
    if (progress.stage === 'ready' || progress.stage === 'error') {
      clearTimeout(this.expiry)
      clearTimeout(this.shutdown)
      this.shutdown = setTimeout(() => { void this.close() }, 60_000)
      this.shutdown.unref()
    }
  }

  async close(): Promise<void> {
    clearTimeout(this.expiry)
    clearTimeout(this.shutdown)
    this.server.closeAllConnections()
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.headers.host !== new URL(this.origin).host) { res.writeHead(403).end(); return }
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return }
    let url: URL
    try { url = new URL(req.url ?? '/', this.origin) } catch { res.writeHead(400).end(); return }
    if (url.pathname === '/oauth/callback') {
      const incoming = Buffer.from(url.searchParams.get('state') ?? '')
      const expected = Buffer.from(this.state)
      if (incoming.length !== expected.length || !timingSafeEqual(incoming, expected)) { res.writeHead(400).end('Invalid OAuth state'); return }
      if (this.consumed) { res.writeHead(409).end('OAuth callback already consumed'); return }
      if (!url.searchParams.get('code') && !url.searchParams.get('error')) { res.writeHead(400).end('Missing authorization code'); return }
      this.consumed = true
      // Drop the code from browser navigation before pairing and bootstrapping.
      res.writeHead(303, { Location: this.progressUrl }).end()
      if (url.searchParams.get('error')) this.onCancel('你已取消授权，可以回到插件重新开始。')
      else this.onCode(url.searchParams.get('code')!)
      return
    }
    if (url.pathname === `${this.progressPath}/status`) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(this.progress))
      return
    }
    if (url.pathname === this.progressPath) {
      const nonce = randomBytes(16).toString('base64')
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(progressHtml(nonce, `${this.progressPath}/status`))
      return
    }
    res.writeHead(404).end()
  }
}

function progressHtml(nonce: string, statusPath: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接设备 · Agents Anywhere</title>
<style nonce="${nonce}">:root{color-scheme:light dark}body{margin:0;font:16px system-ui;min-height:100vh;display:grid;place-items:center}main{max-width:420px;padding:32px;text-align:center}p{line-height:1.8;opacity:.75}</style>
<main><h1>正在连接你的设备</h1><p id="status" role="status">授权已收到，正在准备本机连接…</p></main>
<script nonce="${nonce}">let failures=0;async function tick(){try{const response=await fetch(${JSON.stringify(statusPath)},{cache:'no-store'});if(!response.ok)throw new Error();const result=await response.json();document.getElementById('status').textContent=result.message;failures=0;if(result.stage==='ready'&&result.redirectUrl){location.replace(result.redirectUrl);return}if(result.stage==='error')return}catch{if(++failures>=5){document.getElementById('status').textContent='本机连接已关闭，请回到插件重试。';return}}setTimeout(tick,800)}tick();</script></html>`
}
