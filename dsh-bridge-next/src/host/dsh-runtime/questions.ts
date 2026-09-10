import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { itemId, sessionId } from './identity.js'
import { QuestionForm } from './question-form.js'
import { QuestionStream, type QuestionOutcome } from './question-stream.js'

interface Question {
  eventId: string, agentId: string, form: QuestionForm,
  status: 'open' | 'responding' | 'resolved' | 'closed' | 'cancelled' | 'expired',
  withdrawn: boolean, revision: number,
}

/** Only runtime-owned questions are retained. Connector/modal lifetimes never own the wait. */
export class UserQuestions {
  private entries = new Map<string, Question>()
  private stream: QuestionStream
  get available(): boolean { return this.stream.available }
  constructor(ctx: Context, private visible: (id: string) => Promise<boolean>,
    private changed: (id?: string) => void) {
    this.stream = new QuestionStream(ctx, frame => this.receive(frame), () => this.changed())
  }

  private async receive(frame: Record<string, unknown>): Promise<void> {
    if (frame.type === 'cancel' && typeof frame.eventId === 'string') {
      const entry = this.entries.get(frame.eventId)
      if (entry) { entry.withdrawn = true; this.update(entry, 'closed') }
      return
    }
    if (frame.type !== 'waterfall' || typeof frame.eventId !== 'string') return
    if (this.entries.has(frame.eventId)) return // Official pending replay keeps the event ID.
    let form: QuestionForm | undefined
    try {
      if (frame.event === 'user-questions/request' && typeof frame.agentId === 'string' && await this.visible(frame.agentId)) {
        form = new QuestionForm((frame.request as { questions?: unknown } | undefined)?.questions)
      }
    } catch { /* Unsupported intents, including plan-review, stay with official clients. */ }
    if (!form) { await this.stream.reply(frame.eventId, { kind: 'next' }); return }
    const entry: Question = { eventId: frame.eventId, agentId: frame.agentId as string, form,
      status: 'open', withdrawn: false, revision: 1 }
    this.entries.set(entry.eventId, entry)
    this.changed(entry.agentId)
  }

  private update(entry: Question, status: Question['status']): void {
    if (entry.status === status) return
    entry.status = status; entry.revision++
    this.changed(entry.agentId)
    // Keep a bounded set of closing notices for reconnect/UI reconciliation.
    const closed = [...this.entries.values()].filter(e => !this.pending(e))
    for (const old of closed.slice(0, Math.max(0, closed.length - 128))) this.entries.delete(old.eventId)
  }
  private pending(entry: Question): boolean { return entry.status === 'open' || entry.status === 'responding' }
  waiting(id: string): boolean { return [...this.entries.values()].some(e => e.agentId === id && this.pending(e)) }

  notices(namespace: string, id: string) {
    const platformId = sessionId(namespace, id)
    return [...this.entries.values()].filter(e => e.agentId === id).map(e => {
      const pending = this.pending(e)
      return { noticeId: itemId(platformId, 'question', e.eventId), sessionId: platformId, runtime: 'dsh',
        type: 'interaction', interactionType: 'input_request', title: '需要你的回答', severity: 'info',
        status: e.status, revision: e.revision, responseRequired: pending,
        blocking: pending ? { scope: 'session', targetId: platformId } : null,
        source: { runtime: 'dsh', component: 'dsh.ask_user_question' },
        context: {}, metadata: { eventId: e.eventId },
        actions: pending ? [
          { actionId: 'submit', label: '提交回答', style: 'primary', input: e.form.input() },
          { actionId: 'cancel', label: '取消', style: 'secondary' },
        ] : [] }
    })
  }

  async respond(namespace: string, id: string, noticeId: string, actionId: string, input: unknown) {
    const entry = [...this.entries.values()].find(e => e.agentId === id && itemId(sessionId(namespace, id), 'question', e.eventId) === noticeId)
    if (!entry || entry.status !== 'open' || !await this.visible(id)) return { ok: false, code: 'dsh_question_not_pending', message: '这个问题已处理或已失效。' }
    let outcome: QuestionOutcome
    if (actionId === 'submit') outcome = { kind: 'result', value: entry.form.answer(input) }
    else if (actionId === 'cancel') outcome = { kind: 'rejected', error: { name: 'UserQuestionError', code: 'ASK_CANCELLED', message: '用户取消了问答。' } }
    else return { ok: false, code: 'dsh_question_invalid_action', message: '未知的问答操作。' }
    // Recheck after asynchronous visibility lookup so concurrent answers cannot both submit.
    if (entry.status !== 'open') return { ok: false, code: 'dsh_question_not_pending', message: '这个问题正在处理。' }
    this.update(entry, 'responding')
    try {
      await this.stream.reply(entry.eventId, outcome)
      if (entry.withdrawn) return { ok: false, code: 'dsh_question_not_pending', message: '这个问题已在其他客户端处理或已失效。' }
      this.update(entry, actionId === 'cancel' ? 'cancelled' : 'resolved')
      return { ok: true, result: { resolved: true, noticeId, sessionId: sessionId(namespace, id) } }
    } catch (error) {
      if (!entry.withdrawn) this.update(entry, 'open')
      return { ok: false, code: 'dsh_question_unavailable', message: error instanceof Error ? error.message : 'DSH 问答暂不可用。' }
    }
  }

  observe(id: SessionId, event: SessionEvent): void {
    if (event.type !== 'turn/end') return
    for (const entry of this.entries.values()) if (entry.agentId === id && entry.status === 'open') this.update(entry, 'expired')
  }
  async close(): Promise<void> { await this.stream.close() }
}
