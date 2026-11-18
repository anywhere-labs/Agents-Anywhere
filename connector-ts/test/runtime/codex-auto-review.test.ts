// Codex automatic approval reviews (codex-acp `guardian_assessment:` tool calls) as timeline notices: the outcome,
// the reviewed action, the warning level and the high-risk denial, live and in history replay.
import { describe, expect, it } from 'vitest'

import type { RuntimeEvent } from '../../src/application/ports/runtime-session.js'
import type { JsonRecord } from '../../src/runtime/acp/client.js'
import { AcpRuntimeHandle, peerConnection } from '../../src/runtime/acp/handle.js'
import { guardianReviewEvents, reviewActionSummary, reviewItemId } from '../../src/runtime/profiles/codex/auto-review.js'
import { codexDialect, codexPermissionCatalog } from '../../src/runtime/profiles/codex/index.js'
import { FakeAcpAgent, tick } from '../support/fake-acp-agent.js'

const THREAD = 'native-1'

/** The Codex event codex-acp puts in rawInput (first report) or rawOutput (later reports). */
function review(status: string, riskLevel: string | null, action: JsonRecord = { type: 'execve', source: 'unifiedExec', program: '/bin/rm', argv: ['/bin/rm', '-rf', 'build'], cwd: '/w' }): JsonRecord {
  return { threadId: THREAD, turnId: 'turn-1', reviewId: 'review-1', targetItemId: 'command-1', review: { status, riskLevel, userAuthorization: 'medium', rationale: 'Deletes files.' }, action }
}

describe('Codex automatic approval reviews', () => {
  it('projects a review as a notice whose level and title follow the outcome and the risk', () => {
    const started = guardianReviewEvents({ sessionUpdate: 'tool_call', toolCallId: 'guardian_assessment:review-1', kind: 'think', title: 'Guardian Review', status: 'in_progress', rawInput: review('inProgress', 'medium') }, THREAD, { turnId: 'turn-1' })
    expect(started).toEqual([{
      turnId: 'turn-1',
      type: 'notice',
      itemId: reviewItemId(THREAD, 'review-1'),
      level: 'info',
      kind: 'other',
      text: '自动审查中：运行 /bin/rm -rf build',
      data: {
        review: { status: 'inProgress', riskLevel: 'medium', userAuthorization: 'medium', rationale: 'Deletes files.' },
        action: { type: 'execve', source: 'unifiedExec', program: '/bin/rm', argv: ['/bin/rm', '-rf', 'build'], cwd: '/w' },
        targetItemId: 'command-1',
      },
    }])
    const denied = guardianReviewEvents({ sessionUpdate: 'tool_call_update', toolCallId: 'guardian_assessment:review-1', status: 'failed', rawInput: null, rawOutput: review('denied', 'high') }, THREAD, {})![0] as Extract<RuntimeEvent, { type: 'notice' }>
    expect(denied).toMatchObject({ itemId: reviewItemId(THREAD, 'review-1'), level: 'warning', kind: 'warning', text: '自动审查已拒绝高风险操作：运行 /bin/rm -rf build', data: { highRisk: true } })
    const lowDenied = guardianReviewEvents({ sessionUpdate: 'tool_call_update', toolCallId: 'guardian_assessment:review-1', rawOutput: review('denied', 'low') }, THREAD, {})![0]
    expect(lowDenied).toMatchObject({ level: 'warning', text: '自动审查已拒绝：运行 /bin/rm -rf build' })
    expect((lowDenied as { data: JsonRecord }).data.highRisk).toBeUndefined()
    expect(guardianReviewEvents({ sessionUpdate: 'tool_call_update', toolCallId: 'guardian_assessment:r', rawOutput: review('approved', 'low') }, THREAD, { replay: true })![0]).toMatchObject({ replay: true, level: 'info', text: '自动审查已批准：运行 /bin/rm -rf build' })
    expect(guardianReviewEvents({ sessionUpdate: 'tool_call_update', toolCallId: 'guardian_assessment:r', rawOutput: review('timedOut', null) }, THREAD, {})![0]).toMatchObject({ level: 'warning', text: '自动审查超时：运行 /bin/rm -rf build' })
  })

  it('leaves other tool calls and reports without the Codex event to the generic translation', () => {
    expect(guardianReviewEvents({ sessionUpdate: 'tool_call', toolCallId: 'cmd-1', rawInput: review('denied', 'high') }, THREAD, {})).toBeUndefined()
    expect(guardianReviewEvents({ sessionUpdate: 'tool_call_update', toolCallId: 'guardian_assessment:r', status: 'completed' }, THREAD, {})).toBeUndefined()
    expect(guardianReviewEvents({ sessionUpdate: 'agent_message_chunk', toolCallId: 'guardian_assessment:r' }, THREAD, {})).toBeUndefined()
  })

  it('describes each kind of reviewed action', () => {
    expect(reviewActionSummary({ type: 'command', command: 'npm test' })).toBe('运行 npm test')
    expect(reviewActionSummary({ type: 'writeStdin', processId: '42' })).toBe('向进程 42 发送输入')
    expect(reviewActionSummary({ type: 'applyPatch', files: ['/w/src/a.ts'] })).toBe('编辑 a.ts')
    expect(reviewActionSummary({ type: 'applyPatch', files: ['a', 'b'] })).toBe('编辑 2 个文件')
    expect(reviewActionSummary({ type: 'networkAccess', target: 'example.com' })).toBe('访问网络 example.com')
    expect(reviewActionSummary({ type: 'mcpToolCall', toolName: 'search', connectorName: 'Docs' })).toBe('调用 MCP 工具 search（Docs）')
    expect(reviewActionSummary({ type: 'requestPermissions', reason: 'needs network' })).toBe('申请权限：needs network')
    expect(reviewActionSummary({ type: 'unknown' })).toBeUndefined()
  })

  it('reaches the session as a notice instead of a tool card', async () => {
    const agent = new FakeAcpAgent()
    const dialect = codexDialect()
    const handle = new AcpRuntimeHandle({ type: 'codex', instanceId: 'i1', dialect, connect: peerConnection(agent.clientPeer, dialect), permissionCatalog: codexPermissionCatalog })
    const session = await handle.open({ kind: 'new', spec: { cwd: '/w' } }, { sessionId: 'aa_r1', replay: 'none' })
    const events: RuntimeEvent[] = []
    void (async () => {
      for await (const event of session.events) events.push(event)
    })()
    agent.update(THREAD, { sessionUpdate: 'tool_call', toolCallId: 'guardian_assessment:review-1', kind: 'think', title: 'Guardian Review', status: 'in_progress', rawInput: review('inProgress', 'high') })
    agent.update(THREAD, { sessionUpdate: 'tool_call_update', toolCallId: 'guardian_assessment:review-1', status: 'failed', rawInput: null, rawOutput: review('denied', 'critical') })
    await tick(10)
    const notices = events.filter((e): e is Extract<RuntimeEvent, { type: 'notice' }> => e.type === 'notice')
    expect(notices.map(n => [n.level, n.text])).toEqual([['info', '自动审查中：运行 /bin/rm -rf build'], ['warning', '自动审查已拒绝高风险操作：运行 /bin/rm -rf build']])
    expect(new Set(notices.map(n => n.itemId)).size).toBe(1)
    expect(events.some(e => e.type === 'tool.started' || e.type === 'tool.updated')).toBe(false)
    await session.close()
  })
})
