import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SessionId } from '@deepseek-ai/dsh-session'
import { nativeRuntime } from '../fixtures/native-runtime.js'
import { mountAgents, TextAdapter, initialSelections } from '../fixtures/agent-runtime.js'
import { nativeSessionId } from '../../src/host/dsh-runtime/identity.js'

const probe = (...args: string[]) => promisify(execFile)('uv', ['run', '--frozen', 'python', 'tests/dsh_preset_probe.py', ...args], {
  cwd: new URL('../../../connector/', import.meta.url), timeout: 30_000,
})

test('a Runtime config saved while DSH was offline creates sessions in the DSH default mode', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-dsh-default-preset-'))
  try {
    // A separate Connector process validates and saves the config before DSH runs.
    const offline = await probe('offline', home)
    const values = JSON.parse(offline.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>
    assert.equal('defaultAgentPreset' in values, false, 'the offline config has no Agent mode to send')

    const adapter = new TextAdapter()
    const fixture = await nativeRuntime(home, ctx => mountAgents(ctx, adapter))
    const release = setInterval(() => adapter.release?.(), 10)
    try {
      const expected = fixture.ctx.agentPresets.defaultId
      assert.equal(expected, 'minimal', 'the fixture default differs from standard so the two rules are told apart')
      const { stdout } = await probe('create', home, JSON.stringify(values), JSON.stringify(initialSelections))
      assert.match(stdout, /DSH default preset probe passed/)
      const id = SessionId(nativeSessionId('preset-wire', 'sess_default_preset'))
      const state = await fixture.ctx.agentsAnywhereRuntime.native.configuration.state(id)
      assert.equal(state.metadata.agentPreset, expected)
    } finally {
      clearInterval(release); adapter.release?.(); await fixture.ctx.fiber.dispose()
    }
  } finally { await rm(home, { recursive: true, force: true }) }
})
