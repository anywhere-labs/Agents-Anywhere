import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import { createProjection, projectHistory } from '../../src/host/dsh-runtime/history.js'
import { connectorProject, python } from '../helpers/python-connector.js'

test('normalized history and live items pass the real Python adapter and UTF-8 serialization', async () => {
  const text = '中文 👇 \udc47 \ud83d end'
  const snapshot = { session: { id: 'unicode-history' }, events: [
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call', name: 'run_code', arguments: '{}' } },
    { type: 'tool/result', data: { turn: 1, step: 1, message: {
      toolCallId: 'call', content: [{ type: 'text', text }], isError: false,
    } } },
  ].map((event, seq) => ({ ...event, seq, time: 1000 + seq })) } as SessionLogSnapshot
  const original = JSON.stringify(snapshot)
  const projection = createProjection('unicode-history', 'platform')
  const live = snapshot.events.flatMap(event => {
    projection.apply(event)
    return projection.drain().items
  })
  const cold = projectHistory(snapshot, 'platform')
  assert.deepEqual(projection.snapshot(), cold)
  assert.equal(JSON.stringify(snapshot), original)
  const script = `import json, sys
from dataclasses import asdict
from connector.runtimes.dsh.bridge.models import timeline_item
items = json.loads(sys.argv[1])
for raw in items:
    item = timeline_item(raw)
    json.dumps(asdict(item), ensure_ascii=False).encode("utf-8")
assert items[-1]["content"]["output"] == "中文 👇 � � end"
assert items[-1]["content"]["result"] == [{"type": "text", "text": "中文 👇 � � end"}]
print("Unicode adapter integration passed")
`
  const { stdout } = await promisify(execFile)(python, ['-c', script, JSON.stringify([...live, ...cold])], {
    cwd: connectorProject, timeout: 10_000,
  })
  assert.match(stdout, /Unicode adapter integration passed/)
})
