import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { nativeRuntime } from '../fixtures/native-runtime.js'
import { mountAgents, TextAdapter } from '../fixtures/agent-runtime.js'

interface Model { displayName: string, group: { id: string, displayName: string, itemDisplayName: string | null } | null, metadata: { provider: string, providerName: string, modelName: string } }

test('real Python Connector groups DSH models by the provider that routes them', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-dsh-model-groups-'))
  const fixture = await nativeRuntime(home, ctx => mountAgents(ctx, new TextAdapter()))
  try {
    fixture.ctx.llm.registerAdapter(['other'], new TextAdapter())
    const { stdout } = await promisify(execFile)('uv', ['run', '--frozen', 'python', 'tests/dsh_model_groups_probe.py', home], {
      cwd: new URL('../../../connector/', import.meta.url), timeout: 45_000,
    })
    const models = (JSON.parse(stdout.trim().split('\n').at(-1)!) as { models: Model[] }).models
    assert.deepEqual([...new Set(models.map(model => model.group?.id))], ['test', 'other'])
    for (const model of models) {
      // The row under the provider header drops the provider the title carries for colliding names.
      assert.deepEqual(model.group, { id: model.metadata.provider, displayName: model.metadata.providerName, itemDisplayName: model.metadata.modelName })
    }
    // Same names across providers stay distinguishable for clients that ignore `group`.
    const texts = models.filter(model => model.displayName.startsWith('Text')).map(model => model.displayName)
    assert.equal(texts.length, 2)
    assert.equal(new Set(texts).size, 2)
  } finally { await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
