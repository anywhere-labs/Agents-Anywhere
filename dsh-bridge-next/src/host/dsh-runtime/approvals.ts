import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { itemId, sessionId } from './identity.js'
import { InteractionStream } from './interaction-stream.js'
import { record } from './types.js'
import type { RuntimeDiagnostics } from './diagnostics.js'

interface Approval {
  eventId: string; agentId: string; toolName: string; reason?: string; callId?: string
  status: 'open' | 'responding' | 'resolved' | 'closed' | 'expired'
  withdrawn: boolean; revision: number
}

/** Decisions flow through the official pending request; a grant always applies once. */
export class UserApprovals {
  private entries = new Map<string, Approval>()
  private readonly stream: InteractionStream
  get available(): boolean { return this.stream.available }
  constructor(ctx: Context, private readonly visible: (id: string) => Promise<boolean>, private readonly changed: (id?: string) => void, diagnostics?: RuntimeDiagnostics) {
    this.stream = new InteractionStream(ctx, frame => this.receive(frame), () => changed(), 'approval', diagnostics)
  }
  private async receive(frame: Record<string, unknown>): Promise<void> {
    if (frame.type === 'cancel' && typeof frame.eventId === 'string') {
      const entry = this.entries.get(frame.eventId)
      if (entry) { entry.withdrawn = true; this.update(entry, 'closed') }
      return
    }
    if (frame.type !== 'waterfall' || typeof frame.eventId !== 'string' || this.entries.has(frame.eventId)) return
    const request = record(frame.request)
    let accepted = false
    try { accepted = frame.event === 'approval/request' && typeof frame.agentId === 'string' && typeof request.toolName === 'string' && await this.visible(frame.agentId) }
    catch { /* A hidden or unavailable session must remain with the native answerers. */ }
    if (!accepted) { await this.stream.reply(frame.eventId, { kind: 'next' }); return }
    const entry: Approval = {
      eventId: frame.eventId, agentId: frame.agentId as string, toolName: request.toolName as string,
      ...(typeof request.reason === 'string' ? { reason: request.reason } : {}),
      ...(typeof request.callId === 'string' ? { callId: request.callId } : {}),
      status: 'open', withdrawn: false, revision: 1,
    }
    this.entries.set(entry.eventId, entry)
    this.changed(entry.agentId)
  }
  private pending(entry: Approval): boolean { return entry.status === 'open' || entry.status === 'responding' }
  private update(entry: Approval, status: Approval['status']): void {
    if (entry.status === status) return
    entry.status = status; entry.revision++
    this.changed(entry.agentId)
    const closed = [...this.entries.values()].filter(value => !this.pending(value))
    for (const old of closed.slice(0, Math.max(0, closed.length - 128))) this.entries.delete(old.eventId)
  }
  private find(namespace: string, id: string, noticeId: string): Approval | undefined {
    return [...this.entries.values()].find(entry => entry.agentId === id && itemId(sessionId(namespace, id), 'approval', entry.eventId) === noticeId)
  }
  owns(namespace: string, id: string, noticeId: string): boolean { return this.find(namespace, id, noticeId) !== undefined }
  waiting(id: string): boolean { return [...this.entries.values()].some(entry => entry.agentId === id && this.pending(entry)) }
  notices(namespace: string, id: string) {
    const platformId = sessionId(namespace, id)
    return [...this.entries.values()].filter(entry => entry.agentId === id).map(entry => {
      const pending = this.pending(entry)
      return {
        noticeId: itemId(platformId, 'approval', entry.eventId), sessionId: platformId, runtime: 'dsh',
        type: 'interaction', interactionType: 'approval', title: `请求批准：${entry.toolName}`,
        message: entry.reason ?? '此操作需要你的批准。允许仅对本次请求生效。', severity: 'warning',
        status: entry.status, revision: entry.revision, responseRequired: pending,
        blocking: pending ? { scope: 'session', targetId: platformId } : null,
        source: { runtime: 'dsh', component: 'dsh.approval' },
        context: { toolName: entry.toolName, ...(entry.callId ? { callId: entry.callId } : {}) },
        metadata: { eventId: entry.eventId },
        actions: pending ? [
          { actionId: 'allow-once', label: '允许一次', style: 'primary' },
          { actionId: 'reject', label: '拒绝', style: 'secondary' },
        ] : [],
      }
    })
  }
  async respond(namespace: string, id: string, noticeId: string, actionId: string) {
    const entry = this.find(namespace, id, noticeId)
    const stale = { ok: false, code: 'dsh_approval_not_pending', message: '这个权限请求已处理或已失效。' }
    if (!entry || entry.status !== 'open' || !await this.visible(id)) return stale
    if (actionId !== 'allow-once' && actionId !== 'reject') return { ok: false, code: 'dsh_approval_invalid_action', message: '未知的批准操作。' }
    // Visibility awaits I/O; another client may have decided in the meantime.
    if (entry.status !== 'open') return stale
    this.update(entry, 'responding')
    try {
      await this.stream.reply(entry.eventId, { kind: 'result', value: actionId === 'allow-once' ? 'allowed-once' : 'rejected' })
      if (entry.withdrawn) return stale
      this.update(entry, 'resolved')
      return { ok: true, result: { resolved: true, noticeId, sessionId: sessionId(namespace, id) } }
    } catch {
      if (!entry.withdrawn) this.update(entry, 'open')
      return { ok: false, code: 'dsh_approval_unavailable', message: 'DSH 未接收批准结果，请稍后重试。' }
    }
  }
  observe(id: SessionId, event: SessionEvent): void {
    if (event.type !== 'turn/end') return
    for (const entry of this.entries.values()) if (entry.agentId === id && this.pending(entry)) {
      entry.withdrawn = true; this.update(entry, 'expired')
    }
  }
  async close(): Promise<void> { await this.stream.close() }
}
