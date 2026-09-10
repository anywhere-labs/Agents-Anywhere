import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import { createProjection, projectHistory, replayHistory } from '../../src/host/dsh-runtime/history.js'
import { contentHash, sessionId, itemId } from '../../src/host/dsh-runtime/identity.js'
import { RuntimeRouter } from '../../src/host/dsh-runtime/router.js'
import { readFile } from 'node:fs/promises'

function log(events: { type: string, data: unknown }[]): SessionLogSnapshot {
  return { session: { id: 'native', version: 0, createdAt: 0, isSeeded: false }, inheritedEventCount: 0,
    events: events.map((event, seq) => ({ ...event, seq, time: 1000 + seq })) } as SessionLogSnapshot
}
const start = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'step/start', data: { turn: 1, step: 1 } }]
const call = { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' }
const assistant = (content: unknown[], interrupted = false) => ({ type: 'assistant/message', data: {
  turn: 1, step: 1, interrupted, message: { id: 'assistant', role: 'assistant',
    source: { kind: 'model', provider: 'test', model: 'test', replayState: { secret: 'never expose' } }, content },
} })

test('folds tool blocks, calls and user-role results into one canonical tool item', () => {
  const snapshot = log([...start,
    { type: 'user/message', data: { id: 'user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
    { type: 'user/message', data: { id: 'injection', role: 'user', source: { kind: 'plugin', plugin: 'context' }, content: [{ type: 'text', text: 'context' }] } },
    assistant([call]),
    { type: 'tool/call', data: { turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments } },
    { type: 'tool/result', data: { turn: 1, step: 1, message: { id: 'result', role: 'user', source: { kind: 'tool', callId: call.id },
      content: [{ type: 'tool-result', toolCallId: call.id, content: [{ type: 'text', text: '/workspace' }], isError: false }] } } },
  ])
  const items = projectHistory(snapshot, 'platform')
  const tools = items.filter(item => item.type === 'tool')
  assert.equal(tools.length, 1)
  assert.equal(tools[0]?.status, 'done')
  assert.equal(tools[0]?.content.kind, 'command')
  assert.equal(tools[0]?.content.command, 'pwd')
  assert.equal(tools[0]?.content.output, '/workspace')
  assert.equal(items.filter(item => item.role === 'user').length, 1)
  assert.ok(!items.some(item => item.content.text === 'context'))
  assert.ok(!JSON.stringify(items).includes('never expose'))
  for (const item of items) assert.equal(item.contentHash, contentHash(item))
})

test('partial reasoning/text and completed output reuse IDs and ordering without duplicate messages', () => {
  const events = [...start,
    { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '思考' } } },
    { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: '你' } } },
  ]
  const partial = projectHistory(log(events), 'platform')
  const complete = projectHistory(log([...events, assistant([{ type: 'reasoning', text: '思考完成' }, { type: 'text', text: '你好' }])]), 'platform')
  const before = partial.find(item => item.content.text === '你')!
  const after = complete.find(item => item.content.text === '你好')!
  assert.equal(before.id, after.id)
  assert.equal(before.orderSeq, after.orderSeq)
  assert.equal(before.status, 'running')
  assert.equal(after.status, 'done')
  assert.equal(complete.filter(item => item.type === 'message').length, 1)
  assert.equal(complete.find(item => item.content.kind === 'reasoning')?.status, 'done')
})

test('preserves nested CodeMode calls, structured contextual edits and historical approvals', () => {
  const events = [...start, assistant([{ type: 'tool-call', id: 'root', name: 'run_code', arguments: '{}' }]),
    { type: 'tool/code-dispatch-start', data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:code:1', name: 'web_search', arguments: { query: 'test' } } },
    { type: 'tool/code-dispatch', data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:code:1', name: 'web_search', arguments: { query: 'test' }, isError: false, content: [{ type: 'text', text: 'result' }] } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'edit', name: 'edit', arguments: '{}' } },
    { type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'edit', content: [], isError: false }] }, meta: { diffs: [{ path: '/tmp/a', oldText: 'before', newText: 'after' }] } } },
    { type: 'approval/asked', data: { id: 'approval', toolName: 'edit', callId: 'edit' } },
    { type: 'approval/decided', data: { id: 'approval', outcome: 'allowed-once' } },
  ]
  const items = projectHistory(log(events), 'platform')
  const nested = items.find(item => item.content.callId === 'root:code:1')!
  assert.equal(nested.status, 'done')
  assert.equal(nested.content.kind, 'web_search')
  assert.equal(nested.content.parentItemId, itemId('native', 'tool', 'root'))
  const edit = items.find(item => item.content.callId === 'edit' && item.content.kind === 'file_change')!
  assert.deepEqual(edit.content.changes, [{ path: '/tmp/a', kind: 'update', diff: '-before\n+after', contextual: true }])
  const approvals = items.filter(item => item.content.kind === 'permission')
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0]?.content.readOnly, true)
  assert.equal(approvals[0]?.content.outcome, 'allowed-once')
})

function writeLog(content: string, outcome = 'Created', diffs: unknown[] = [], failed = false) {
  return log([...start,
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'write', name: 'write', arguments: JSON.stringify({ file_path: '/workspace/index.html', content }) } },
    { type: 'tool/result', data: { turn: 1, step: 1, meta: { diffs }, message: {
      content: [{ type: 'tool-result', toolCallId: 'write', isError: failed, content: [{ type: 'text',
        text: `<path>/workspace/index.html</path>\n<type>file</type>\n<content>\n${outcome} file\n</content>` }] }],
    } } },
  ])
}

test('native write creation with empty diffs becomes one added file in history and live events', () => {
  for (const [content, diff] of [['<html>\n</html>\n', '+<html>\n+</html>'], ['one\r\ntwo\r\n', '+one\n+two'], ['', '']]) {
    const snapshot = writeLog(content!)
    const projection = createProjection('native', 'platform')
    for (const event of snapshot.events.slice(0, -1)) projection.apply(event)
    const pending = projection.drain().items.find(item => item.type === 'tool')!
    assert.equal(pending.status, 'running')
    projection.apply(snapshot.events.at(-1)!)
    const item = projection.drain().items.find(item => item.type === 'tool')!
    assert.equal(item.id, pending.id, 'Completion updates the original tool item')
    assert.equal(item.orderSeq, pending.orderSeq)
    assert.equal(item.status, 'done')
    assert.equal(item.content.kind, 'file_change')
    assert.deepEqual(item.content.changes, [{ path: '/workspace/index.html', kind: 'add', diff, contextual: false }])
    assert.equal(item.contentHash, contentHash(item))
    assert.deepEqual(projection.snapshot(), projectHistory(snapshot, 'platform'))
  }
})

test('write overwrite hunks remain modifications and do not invent a deleted empty line', () => {
  const snapshot = writeLog('before\ninserted\n', 'Updated', [{ path: '/workspace/index.html', oldText: null, newText: 'inserted' }])
  const item = projectHistory(snapshot, 'platform').find(item => item.type === 'tool')!
  assert.equal(item.content.kind, 'file_change')
  assert.deepEqual(item.content.changes, [{ path: '/workspace/index.html', kind: 'update', diff: '+inserted', contextual: true }])
})

test('unchanged overwrites, unknown acknowledgements and failed writes never become new files', () => {
  for (const snapshot of [writeLog('same', 'Updated'), writeLog('new', 'Possibly Created'), writeLog('new', 'Created', [], true),
    writeLog('new', 'Created', [{ path: '/workspace/index.html', oldText: null, newText: 'new' }], true)]) {
    const item = projectHistory(snapshot, 'platform').find(item => item.type === 'tool')!
    assert.equal(item.content.kind, 'tool_call')
    assert.equal(item.content.changes, undefined)
  }
})

test('cancelled streams drop undispatched tools and retain image references without fake attachment IDs', () => {
  const events = [...start,
    { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'dropped', name: 'bash', argumentsDelta: '{}' } } },
    assistant([], true),
    { type: 'user/message', data: { id: 'image', role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: { id: 'native-image' } }] } },
    { type: 'request/header', data: { header: { secret: 'private model config' } } },
  ]
  const items = projectHistory(log(events), 'platform')
  assert.ok(!items.some(item => item.content.callId === 'dropped'))
  assert.ok(items.some(item => item.content.text === '[图片暂不支持跨设备预览]'))
  assert.ok(!JSON.stringify(items).includes('private model config'))
})

test('compaction keeps original messages and ignores internal informational events', () => {
  const snapshot = log([...start, assistant([{ type: 'text', text: 'original' }]),
    { type: 'compaction/summary', data: { summary: 'compressed' } },
    { type: 'extension/notice', data: { note: 'future' } },
  ])
  const items = projectHistory(snapshot, 'platform')
  assert.ok(items.some(item => item.content.text === 'original'))
  assert.ok(items.some(item => item.type === 'marker' && item.content.kind === 'compact'))
  assert.ok(!items.some(item => item.content.eventType === 'extension/notice'))
})

test('canonical identities and hashes match the shared cross-language fixtures', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../../contracts/dsh-bridge/1.0/fixtures/identity.json', import.meta.url), 'utf8'))
  for (const entry of fixture.sessionIds) assert.equal(sessionId(entry.connectorId, entry.externalSessionId), entry.sessionId)
  for (const entry of fixture.timelineIds) assert.equal(itemId(entry.externalSessionId, entry.projectionKind, entry.businessId), entry.itemId)
  for (const entry of fixture.contentHashes) assert.equal(contentHash(entry), entry.contentHash)
})

test('read cursors capture one complete inventory and truncated snapshots are never marked complete', async () => {
  const snapshot = log([...start, assistant([{ type: 'text', text: 'hello' }])])
  const records = [{ header: snapshot.session, live: true, persisted: true }]
  const router = new RuntimeRouter({ query: {
    listSessions: async () => records,
    readTitleSnapshots: async ids => ids.map(sessionId => ({ sessionId, status: 'fulfilled' as const, value: { session: snapshot.session } })),
    readSession: async () => snapshot,
  }, status: () => undefined }, 'instance')
  const params = { sessionId: sessionId('instance', 'native'), externalSessionId: 'native' }
  const limited = await router.request('session.getSnapshot', { ...params, limit: 1 }, new AbortController().signal) as { complete: boolean, items: unknown[] }
  assert.equal(limited.complete, false)
  assert.equal(limited.items.length, 1)
  await assert.rejects(router.request('session.startTurn', params, new AbortController().signal), { code: 'UNSUPPORTED_OPERATION' })
  await assert.rejects(router.request('session.getSnapshot', { ...params, sessionId: 'foreign' }, new AbortController().signal), /namespace/)
})


test('streamed tool JSON is parsed once per drain, not once per token', () => {
  const input = JSON.stringify({ command: 'x'.repeat(10_000) })
  const snapshot = log([...start, ...Array.from(input, argumentsDelta => ({ type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'stream-call', name: 'bash', argumentsDelta } } }))])
  const parse = JSON.parse
  let parses = 0
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { parses++; return parse(...args) }) as typeof JSON.parse
  try {
    const projection = createProjection('native', 'platform')
    for (const event of snapshot.events) projection.apply(event)
    assert.equal(parses, 0)
    assert.equal(projection.dirty, true)
    const delta = projection.drain()
    assert.equal(parses, 1)
    assert.equal(delta.items.find(item => item.type === 'tool')?.content.command, 'x'.repeat(10_000))
    projection.snapshot()
    assert.equal(parses, 1)
  } finally { JSON.parse = parse }
})


test('large replay yields to control work and observes cancellation before completing', async () => {
  const snapshot = log(Array.from({ length: 1000 }, () => ({ type: 'internal/test', data: {} })))
  const abort = new AbortController()
  const projection = createProjection('native', 'platform')
  let applied = 0
  const apply = projection.apply
  projection.apply = (...args) => {
    applied++
    const end = performance.now() + 0.05
    while (performance.now() < end) { /* deterministic CPU load crossing the replay slice */ }
    apply(...args)
  }
  const timer = setTimeout(() => abort.abort(), 0)
  try {
    await assert.rejects(replayHistory(projection, snapshot, abort.signal), { name: 'AbortError' })
    assert.ok(applied < snapshot.events.length)
  } finally { clearTimeout(timer) }
})
