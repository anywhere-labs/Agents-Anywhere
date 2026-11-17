import assert from 'node:assert/strict'
import test from 'node:test'
import { detectHostKind } from '../../src/host/acp/host-kind.js'

const proc = (patch: { electron?: string, env?: Record<string, string>, argv?: string[] }) =>
  ({ versions: { node: '22.0.0', ...(patch.electron ? { electron: patch.electron } : {}) }, env: patch.env ?? {}, argv: ['node', 'dsh', ...(patch.argv ?? [])] }) as never

test('the hello names the DSH front end the plugin runs in', () => {
  assert.equal(detectHostKind(proc({ electron: '38.0.0' })), 'desktop')
  assert.equal(detectHostKind(proc({ env: { ELECTRON_RUN_AS_NODE: '1' } })), 'desktop')
  assert.equal(detectHostKind(proc({ argv: ['--profile', 'default', 'web'] })), 'web')
  assert.equal(detectHostKind(proc({ argv: ['web', '--port', '3000'] })), 'web')
  assert.equal(detectHostKind(proc({ argv: ['run', 'web'] })), 'unknown')
  assert.equal(detectHostKind(proc({})), 'unknown')
})
