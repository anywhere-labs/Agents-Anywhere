import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { MobileLoginSnapshot } from '../../contracts/mobile.js'
import type { Account, AccountApi, MobileStatus } from './api.js'

// qrcode's Node entry renders PNG without Canvas. Keep the browser-only Canvas
// overloads out of the Host type program.
const QRCode = createRequire(import.meta.url)('qrcode') as {
  toDataURL(text: string, options: { errorCorrectionLevel: 'M'; margin: number; width: number }): Promise<string>
}

interface Session {
  account: Account
  api: AccountApi
  token: string
  deadline: number
  snapshot: MobileLoginSnapshot
  controller: AbortController
}
const statuses = new Set(['pending_scan', 'pending_web_confirm', 'approved', 'consumed', 'rejected', 'expired'])
const finished = new Set(['consumed', 'rejected', 'expired'])

/** Ephemeral, account-bound QR flow. No phone or user credentials are persisted. */
export class MobileLogin {
  private session: Session | null = null
  private controller: AbortController | null = null
  private operations: Promise<unknown> = Promise.resolve()

  clear(): void {
    this.controller?.abort()
    this.session?.controller.abort()
    this.controller = null
    this.session = null
  }

  create(account: Account, api: AccountApi): Promise<MobileLoginSnapshot> {
    this.clear()
    const controller = new AbortController()
    this.controller = controller
    return this.serial(async () => {
      controller.signal.throwIfAborted()
      const requestedAt = Date.now()
      const qr = await api.createMobileQr(account.accessToken, controller.signal)
      controller.signal.throwIfAborted()
      const ttl = Date.parse(qr.expiresAt) - Date.parse(qr.serverTime)
      if (qr.userId !== account.userId || typeof qr.loginToken !== 'string' || !qr.loginToken || qr.loginToken.length > 4096
        || !Number.isFinite(ttl) || ttl <= 0 || ttl > 30 * 60_000) throw new Error('手机连接二维码响应无效，请重试。')
      // Matches the existing Android/iOS scanner contract. This must be the API
      // origin (including its port), not DSH's localhost or the OAuth web origin.
      const payload = JSON.stringify({ type: 'agents-anywhere.mobile-login', version: 1,
        webUrl: account.apiBaseUrl, userId: qr.userId, loginToken: qr.loginToken, expiresAt: qr.expiresAt })
      const qrImage = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 4, width: 320 })
      controller.signal.throwIfAborted()
      // Conservatively include request/render latency in the remaining lifetime.
      const deadline = requestedAt + ttl
      this.session = { account, api, token: qr.loginToken, deadline, controller,
        snapshot: { id: randomUUID(), status: 'pending_scan', qrImage, expiresAt: new Date(deadline).toISOString(), deviceName: null } }
      return { ...this.session.snapshot }
    })
  }

  inspect(id: string, account: Account): Promise<MobileLoginSnapshot> {
    return this.serial(async () => {
      const session = this.require(id, account)
      if (!finished.has(session.snapshot.status)) {
        const status = await session.api.mobileStatus(account.accessToken, session.token, session.controller.signal)
        this.apply(session, status)
      }
      return { ...session.snapshot }
    })
  }

  confirm(id: string, approved: boolean, account: Account): Promise<MobileLoginSnapshot> {
    return this.serial(async () => {
      if (typeof approved !== 'boolean') throw new Error('请选择确认或拒绝连接。')
      const session = this.require(id, account)
      if (session.snapshot.status !== 'pending_web_confirm') throw new Error('手机连接状态已变化，请刷新后重试。')
      const status = await session.api.confirmMobile(account.accessToken, session.token, approved, session.controller.signal)
      this.apply(session, status)
      return { ...session.snapshot }
    })
  }

  private require(id: string, account: Account): Session {
    const session = this.session
    if (!session || session.snapshot.id !== id || session.account.userId !== account.userId
      || session.account.apiBaseUrl !== account.apiBaseUrl || session.account.accessToken !== account.accessToken) {
      throw new Error('二维码已失效，请重新生成。')
    }
    if (Date.now() >= session.deadline && !finished.has(session.snapshot.status)) {
      session.snapshot = { ...session.snapshot, status: 'expired', qrImage: null }
    }
    return session
  }

  private apply(session: Session, status: MobileStatus): void {
    session.controller.signal.throwIfAborted()
    if (this.session !== session) throw new Error('二维码已失效，请重新生成。')
    if (!statuses.has(status.status) || (status.userId && status.userId !== session.account.userId)) throw new Error('手机连接状态无效，请重试。')
    session.snapshot = { ...session.snapshot, status: status.status,
      qrImage: status.status === 'pending_scan' ? session.snapshot.qrImage : null,
      deviceName: typeof status.deviceName === 'string' ? status.deviceName.slice(0, 200) : null }
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const work = this.operations.then(action)
    this.operations = work.catch(() => undefined)
    return work
  }
}
