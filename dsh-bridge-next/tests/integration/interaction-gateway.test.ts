import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { UserQuestions } from '../../src/host/dsh-runtime/questions.js'
import { UserApprovals } from '../../src/host/dsh-runtime/approvals.js'
import { readInputRequestForm, createInputRequestDrafts, inputRequestIsComplete, buildInputRequestPayload } from '../../../web-next/src/components/session/input-request.js'

// Resolve the whole official transport from one installation so Cordis identities stay shared.
// CI uses the declared runtime; DSH_INTERACTION_RUNTIME_ROOT also exercises a Desktop installation.
const requireRuntime = createRequire(process.env.DSH_INTERACTION_RUNTIME_ROOT
  ? resolve(process.env.DSH_INTERACTION_RUNTIME_ROOT, 'package.json') : import.meta.url)
const official = (name: string) => import(pathToFileURL(requireRuntime.resolve(name)).href)

async function until(check: () => boolean) {
  for (let n = 0; n < 300; n++) { if (check()) return; await delay(10) }
  assert.ok(check(), 'official interaction stream did not reach the expected state')
}

test('published Gateway carries questions, plan review and approvals into the existing AA form', { timeout: 20_000 }, async () => {
  const { Context } = await official('@deepseek-ai/cordis')
  const { default: Registry } = await official('@deepseek-ai/dsh-typert-registry')
  const { default: Gateway } = await official('@deepseek-ai/dsh-api-gateway')
  const { HostConnectionService } = await official('@deepseek-ai/dsh-client-connection')
  const ctx = new Context()
  const queue: any[] = []
  let wake: (() => void) | undefined
  let questions: UserQuestions | undefined
  let approvals: UserApprovals | undefined
  try {
    await ctx.plugin(Registry).await()
    new HostConnectionService(ctx, [], {})
    await ctx.plugin(Gateway).await()
    // The producer below supplies official Remote dispatches; the separate user-questions
    // suite covers the real Agent/tool/Loader. This test isolates versioned transport.
    ctx.provide('userQuestions', {})
    ctx.provide('approval', {})
    ctx.effect(() => ctx.typertGateway.registerRemoteEvents(async function* (signal: AbortSignal) {
      const abort = () => wake?.()
      signal.addEventListener('abort', abort, { once: true })
      try {
        while (!signal.aborted) {
          while (queue.length) yield queue.shift()
          if (!signal.aborted) await new Promise<void>(resolve => { wake = resolve })
        }
      } finally { signal.removeEventListener('abort', abort) }
    }, { home: '/test' }))
    const visible = async (id: string) => id === 'visible'
    questions = new UserQuestions(ctx, visible, () => {})
    approvals = new UserApprovals(ctx, visible, () => {})
    await until(() => questions!.available && approvals!.available)
    const dispatch = (event: string, request: object, id = 'visible') => {
      const agent = {}
      const result = new Promise<any>((resolve, reject) => {
        queue.push({ event, request: { ...request, agent }, context: { value: ctx, subject: agent, agentId: id }, resolve, reject })
      })
      wake?.()
      return result
    }
    const cases = [
      { id: 'q', question: '选择一个任务', multiSelect: true, options: [{ label: '导出', description: '写出文件' }, { label: '核对' }] },
      { id: 'q', question: '单选', options: [{ label: '继续' }] },
      { id: 'q', question: '补充说明' },
      { id: 'q', question: '是否执行？', detail: '# 计划\n\n先检查，再修改。', intent: { kind: 'plan-review', approve: '批准' }, options: [{ label: '修改' }, { label: '批准' }] },
    ]
    for (const q of cases) {
      const result = dispatch('user-questions/request', { questions: [q] })
      await until(() => questions!.waiting('visible'))
      const notice = questions.notices('test', 'visible').find(n => n.status === 'open')!
      const form = readInputRequestForm(notice as any)!
      assert.ok(form, 'reuse AA inputRequest parser, without a DSH-specific frontend')
      const drafts = createInputRequestDrafts(form)
      drafts.q = { optionIds: q.options ? q.options.map((_, i) => `o_${i}`).slice(q.multiSelect ? 0 : -1) : [], customText: q.options ? '' : '说明', useCustom: !q.options }
      assert.equal(inputRequestIsComplete(form, drafts), true)
      assert.equal((await questions.respond('test', 'visible', notice.noticeId, 'submit', buildInputRequestPayload(form, drafts))).ok, true)
      assert.deepEqual(await result, { kind: 'result', value: { answers: [{ id: 'q', selected: q.options ? q.options.map(o => o.label).slice(q.multiSelect ? 0 : -1) : [], ...(!q.options ? { custom: '说明' } : {}) }] } })
    }
    for (const [action, value] of [['allow-once', 'allowed-once'], ['reject', 'rejected']]) {
      const result = dispatch('approval/request', { toolName: 'bash', reason: '需要批准' })
      await until(() => approvals!.waiting('visible'))
      const notice = approvals.notices('test', 'visible').find(n => n.status === 'open')!
      assert.equal(notice.interactionType, 'approval')
      assert.equal((await approvals.respond('test', 'visible', notice.noticeId, action!)).ok, true)
      assert.deepEqual(await result, { kind: 'result', value })
    }
    const cancelled = dispatch('user-questions/request', { questions: [cases[0]] }).catch(error => error)
    await until(() => questions!.waiting('visible'))
    const noticeId = questions.notices('test', 'visible').find(n => n.status === 'open')!.noticeId
    await questions.close()
    questions = new UserQuestions(ctx, visible, () => {})
    await until(() => questions!.waiting('visible'))
    assert.equal(questions.notices('test', 'visible')[0]!.noticeId, noticeId, 'replay retains native request identity')
    assert.equal((await questions.respond('test', 'visible', noticeId, 'cancel', undefined)).ok, true)
    assert.equal((await cancelled).code, 'ASK_CANCELLED')
    assert.deepEqual(await dispatch('user-questions/request', { questions: [cases[0]] }, 'hidden'), { kind: 'next' })
    assert.deepEqual(await dispatch('future/request', {}), { kind: 'next' })
  } finally {
    await questions?.close()
    await approvals?.close()
    await ctx.fiber.dispose()
  }
})
