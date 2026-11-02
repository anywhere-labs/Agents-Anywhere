import test from 'node:test'
import assert from 'node:assert/strict'
import { applyConnection, parseConnection, type ProviderSettingsHost } from '../../src/host/dsh-runtime/model-connection.js'

type Op = { op: 'set', path: readonly string[], value: unknown } | { op: 'unset', path: readonly string[] }

function fakeHost(providers: Record<string, unknown> = {}, options: { writable?: boolean, conflicts?: number } = {}) {
  const state = { providers: { ...providers }, revision: 1, credentials: new Map<string, string>(), mutations: [] as Op[][] }
  let conflicts = options.conflicts ?? 0
  const host: ProviderSettingsHost = {
    settings: {
      writable: options.writable ?? true,
      describe: () => [{ ns: 'llm-pi-ai', value: { providers: { ...state.providers } }, revision: state.revision }],
      async mutate(ns, ops, expected) {
        assert.equal(ns, 'llm-pi-ai')
        if (conflicts-- > 0 || expected !== state.revision) {
          state.revision++
          throw Object.assign(new Error('changed'), { code: 'SETTINGS_CONFLICT' })
        }
        state.mutations.push([...ops])
        for (const op of ops) {
          const name = op.path[1]!
          if (op.op === 'set') state.providers[name] = op.value
          else delete state.providers[name]
        }
        state.revision++
      },
    },
    credentials: {
      async set(ref, value) { state.credentials.set(ref, value) },
      async unset(ref) { state.credentials.delete(ref) },
    },
    llm: { listConfigurableProviders: () => [{ provider: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] }] },
  }
  return { host, state }
}

const connection = parseConnection({
  protocol: 'openai_chat', baseUrl: 'https://tokens.test/v1/', apiKey: 'sk-secret',
  models: [{ id: 'gpt-5', name: 'GPT-5' }, { id: 'deepseek-v3' }],
})

test('writes one AA route with a credential reference, never the key', async () => {
  const { host, state } = fakeHost({ openai: { apiKeyEnv: 'OPENAI_API_KEY' } })

  assert.deepEqual(await applyConnection(host, connection), { provider: 'aa-tokens-openai-chat' })

  assert.deepEqual(state.providers['aa-tokens-openai-chat'], {
    displayName: 'Agents Anywhere', api: 'openai-completions', baseURL: 'https://tokens.test/v1',
    apiKeyEnv: 'AA_TOKENS_OPENAI_CHAT_API_KEY',
    models: [{ id: 'gpt-5', name: 'GPT-5' }, { id: 'deepseek-v3', name: 'deepseek-v3' }],
  })
  assert.deepEqual(state.providers.openai, { apiKeyEnv: 'OPENAI_API_KEY' })
  assert.equal(state.credentials.get('AA_TOKENS_OPENAI_CHAT_API_KEY'), 'sk-secret')
  assert.ok(!JSON.stringify(state.mutations).includes('sk-secret'))
})

test('switching protocol or clearing removes only routes AA owns', async () => {
  const { host, state } = fakeHost({ openai: {}, 'aa-tokens-anthropic': {} })
  state.credentials.set('AA_TOKENS_ANTHROPIC_API_KEY', 'old')

  await applyConnection(host, connection)
  assert.deepEqual(Object.keys(state.providers).sort(), ['aa-tokens-openai-chat', 'openai'])
  assert.equal(state.credentials.has('AA_TOKENS_ANTHROPIC_API_KEY'), false)

  assert.deepEqual(await applyConnection(host, null), { provider: null })
  assert.deepEqual(Object.keys(state.providers), ['openai'])
  assert.equal(state.credentials.size, 0)
})

test('rereads settings once when someone saved in between', async () => {
  const { host, state } = fakeHost({}, { conflicts: 1 })
  await applyConnection(host, connection)
  assert.equal(state.mutations.length, 1)
})

test('refuses a read-only profile and malformed connections', async () => {
  const { host } = fakeHost({}, { writable: false })
  await assert.rejects(applyConnection(host, connection), /read-only/)
  assert.throws(() => parseConnection({ protocol: 'gemini', baseUrl: 'https://x.test', apiKey: 'k', models: [{ id: 'm' }] }), /protocol/)
  assert.throws(() => parseConnection({ protocol: 'anthropic', baseUrl: 'https://x.test', apiKey: 'k', models: [] }), /model/)
  assert.equal(parseConnection(null), null)
})
