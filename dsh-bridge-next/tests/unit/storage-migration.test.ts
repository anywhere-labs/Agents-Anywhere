import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, stateRoot } from '../../src/host/config.js'
import { acquireManagerLock, readJson, writeJson } from '../../src/host/storage/files.js'
import { migrateStateRoot } from '../../src/host/storage/migration.js'
import { OnboardingManager } from '../../src/host/onboarding/manager.js'

async function fixture(run: (source: string, target: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'aa-migration-中文 '))
  try { await run(join(home, '.agentsanywhere', 'dsh-bridge-next'), join(home, '.agents-anywhere', 'dsh-bridge-next')) }
  finally { await rm(home, { recursive: true, force: true }) }
}

test('defaults share the canonical root and explicit stateRoot remains untouched', () => {
  assert.equal(stateRoot({}), join(userInfo().homedir, '.agents-anywhere', 'dsh-bridge-next'))
  assert.equal(resolveConfig({}).legacyStateRoot, join(userInfo().homedir, '.agentsanywhere', 'dsh-bridge-next'))
  const custom = join(tmpdir(), 'custom-aa')
  assert.equal(resolveConfig({ stateRoot: custom }).stateRoot, custom)
  assert.equal(resolveConfig({ stateRoot: custom }).legacyStateRoot, undefined)
})

test('full data copy preserves both agents checkpoints and KV, relocates config and retains source', async () => {
  await fixture(async (source, target) => {
    for (const agent of ['codex', 'dsh']) {
      for (const file of ['sync-state.json', 'kv.json']) {
        await writeJson(join(source, 'connector', 'conn_test', agent, file), { version: 1, [agent]: { throughSeq: 42, hash: 'unchanged' } })
      }
    }
    await writeJson(join(source, 'account.json'), { accessToken: 'test-token' })
    await writeJson(join(source, 'connector', 'connector.json'), {
      statePath: join(source, 'connector', 'conn_test.sqlite3'),
      attachmentsRoot: join(tmpdir(), 'custom-attachments'),
    })
    await writeJson(join(source, 'connector-venv', 'cache.json'), {})
    await migrateStateRoot(target, source)
    for (const agent of ['codex', 'dsh']) {
      for (const file of ['sync-state.json', 'kv.json']) {
        const suffix = join('connector', 'conn_test', agent, file)
        assert.equal(await readFile(join(target, suffix), 'utf8'), await readFile(join(source, suffix), 'utf8'))
      }
    }
    assert.deepEqual(await readJson(join(target, 'account.json')), { accessToken: 'test-token' })
    assert.deepEqual(await readJson(join(target, 'connector', 'connector.json')), {
      statePath: join(target, 'connector', 'conn_test.sqlite3'), attachmentsRoot: join(tmpdir(), 'custom-attachments'),
    })
    assert.equal(await readJson(join(target, 'connector-venv', 'cache.json')), null)
    if (process.platform !== 'win32') assert.equal((await stat(join(target, 'account.json'))).mode & 0o777, 0o600)
  })
})

test('new files win conflicts; logout and reset are not undone by later startups', async () => {
  await fixture(async (source, target) => {
    await writeJson(join(source, 'account.json'), { accessToken: 'old' })
    await writeJson(join(source, 'connector', 'conn', 'dsh', 'sync-state.json'), { throughSeq: 10 })
    await writeJson(join(target, 'account.json'), { accessToken: 'new' })
    await writeJson(join(target, 'connector', 'conn', 'dsh', 'sync-state.json'), { throughSeq: 20 })
    await migrateStateRoot(target, source)
    assert.deepEqual(await readJson(join(target, 'account.json')), { accessToken: 'new' })
    assert.deepEqual(await readJson(join(target, 'connector', 'conn', 'dsh', 'sync-state.json')), { throughSeq: 20 })
    await rm(join(target, 'account.json'))
    await rm(join(target, 'connector'), { recursive: true })
    await migrateStateRoot(target, source)
    assert.equal(await readJson(join(target, 'account.json')), null)
    assert.equal(await readJson(join(target, 'connector', 'conn', 'dsh', 'sync-state.json')), null)
  })
})

test('first launch without legacy data and custom roots do not import later legacy files', async () => {
  await fixture(async (source, target) => {
    await migrateStateRoot(target, source)
    await writeJson(join(source, 'account.json'), { accessToken: 'old' })
    await migrateStateRoot(target, source)
    assert.equal(await readJson(join(target, 'account.json')), null)
    await migrateStateRoot(join(target, 'custom'))
    await assert.rejects(stat(join(target, 'custom')), { code: 'ENOENT' })
  })
})

test('running old instance blocks migration and release permits retry', async () => {
  await fixture(async (source, target) => {
    const release = await acquireManagerLock(join(source, 'manager.lock'))
    try { await assert.rejects(migrateStateRoot(target, source), /另一个插件实例/) }
    finally { await release() }
    assert.equal(await readJson(join(target, '.legacy-state-migrated.json')), null)
    await migrateStateRoot(target, source)
  })
})

test('copy failure leaves no completion receipt and retries missing files without overwriting new ones', async () => {
  await fixture(async (source, target) => {
    await writeJson(join(source, 'account.json'), { accessToken: 'old' })
    await writeJson(join(source, 'connector', 'connector.json'), {})
    await writeFile(join(source, 'connector', 'connector.json'), '{broken')
    await assert.rejects(migrateStateRoot(target, source), /格式无效/)
    assert.equal(await readJson(join(target, '.legacy-state-migrated.json')), null)
    assert.equal(await readJson(join(target, 'connector', 'connector.json')), null)
    await writeJson(join(target, 'account.json'), { accessToken: 'new' })
    await writeJson(join(source, 'connector', 'connector.json'), {})
    await migrateStateRoot(target, source)
    assert.deepEqual(await readJson(join(target, 'account.json')), { accessToken: 'new' })
  })
})

test('symlinks fail explicitly instead of keeping checkpoint writes in the old directory', async () => {
  await fixture(async (source, target) => {
    await writeJson(join(source, 'account.json'), {})
    await symlink(join(source, 'account.json'), join(source, 'checkpoint.json'))
    await assert.rejects(migrateStateRoot(target, source), /非普通文件/)
    assert.equal(await readJson(join(target, '.legacy-state-migrated.json')), null)
  })
})

test('manager migrates before reading settings and serializes startup; failed migration prevents initialization', async () => {
  await fixture(async (source, target) => {
    await writeJson(join(source, 'settings.json'), { apiBaseUrl: 'https://migrated.example.test' })
    const config = { stateRoot: target, legacyStateRoot: source, connectorSourceDir: target, uvPath: 'uv', apiBaseUrl: 'https://default.example.test' }
    const dependencies = { detect: async () => ({ status: 'absent' as const, message: '' }), systemLanguages: async () => ['en-US'] }
    const first = new OnboardingManager(config, dependencies)
    const second = new OnboardingManager(config, dependencies)
    try {
      const attempts = await Promise.allSettled([first.initialize(), second.initialize()])
      assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
      const winner = attempts[0]!.status === 'fulfilled' ? first : second
      assert.equal((await winner.inspect()).settings.apiBaseUrl, 'https://migrated.example.test')
    } finally { await first.dispose(); await second.dispose() }
    await rm(join(target, '.legacy-state-migrated.json'))
    await writeFile(join(source, 'broken-link'), 'file')
    await writeJson(join(target, 'broken-link', 'nested.json'), {})
    let reads = 0
    const failed = new OnboardingManager(config, { ...dependencies, detect: async () => { reads++; return dependencies.detect() } })
    try { await assert.rejects(failed.initialize(), /冲突/); assert.equal(reads, 0) }
    finally { await failed.dispose() }
  })
})
