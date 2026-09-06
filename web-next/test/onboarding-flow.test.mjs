import assert from 'node:assert/strict'
import test from 'node:test'
import { registerSource } from './helpers/onboarding-source.mjs'

const hooks = registerSource()
const { readNativeOAuthParams, isPluginRedirect } = await import('../src/features/auth/native-oauth.ts')
const { rememberAuthFlow, takeAuthFlow } = await import('../src/features/auth/continuation.ts')
const { readOnboardingTarget, restoreOnboardingStep, saveOnboardingStep } = await import('../src/features/onboarding/flow.ts')
hooks.deregister()

const storage = () => {
  const values = new Map()
  return { setItem: (key, value) => values.set(key, value), getItem: key => values.get(key) ?? null, removeItem: key => values.delete(key) }
}

test('plugin OAuth accepts only its exact native loopback client, S256 and state', () => {
  const params = new URLSearchParams({ response_type: 'code', client_id: 'agents-anywhere-dsh-plugin', redirect_uri: 'http://127.0.0.1:50000/oauth/callback', code_challenge: 'a'.repeat(43), state: 'b'.repeat(43) })
  assert.ok(readNativeOAuthParams(params, 'plugin'))
  assert.equal(readNativeOAuthParams(params, 'desktop'), null)
  assert.equal(isPluginRedirect('http://127.0.0.1:5000/oauth/callback\n'), false)
  for (const uri of ['http://localhost:5000/oauth/callback', 'http://127.0.0.1:5000/oauth/callback?next=evil', 'http://127.0.0.1.evil:5000/oauth/callback', 'http://127.0.0.1:80/oauth/callback', 'http://127.0.0.1:65536/oauth/callback', 'http://user@127.0.0.1:5000/oauth/callback']) assert.equal(isPluginRedirect(uri), false)
  params.delete('state')
  assert.equal(readNativeOAuthParams(params, 'plugin'), null)
})

test('login and registration preserve onboarding context without allowing external redirects', () => {
  const store = storage()
  const hash = '#/onboarding?source=dsh-plugin&connectorId=conn_demo&flowId=abcdefghijklmnop'
  rememberAuthFlow(hash, store)
  assert.equal(takeAuthFlow('#/register', store), hash)
  assert.equal(takeAuthFlow('#/login', store), null)
  rememberAuthFlow('https://evil.test/', store)
  assert.equal(takeAuthFlow('#/login', store), null)
  assert.equal(takeAuthFlow(hash, store), hash)
})

test('onboarding restores per account, device and flow; a new plugin launch starts a new flow', () => {
  const params = new URLSearchParams({ source: 'dsh-plugin', connectorId: 'conn_demo', flowId: 'abcdefghijklmnop' })
  const target = readOnboardingTarget(params)
  assert.ok(target)
  const store = storage()
  saveOnboardingStep(target, 'user1', 'complete', store)
  assert.equal(restoreOnboardingStep(target, 'user1', store), 'complete')
  assert.equal(restoreOnboardingStep(target, 'user2', store), 'welcome')
  assert.equal(restoreOnboardingStep({ ...target, flowId: 'new-flow-id-1234567' }, 'user1', store), 'welcome')
  params.set('connectorId', '../another-device')
  assert.equal(readOnboardingTarget(params), null)
})

test('the four-page onboarding resumes both current and previously saved steps', () => {
  const target = { connectorId: 'conn_demo', flowId: 'abcdefghijklmnop' }
  for (const [saved, expected] of [['welcome', 'welcome'], ['device', 'device'], ['phone', 'phone'], ['agents', 'device'], ['mobile-choice', 'phone'], ['mobile', 'phone'], ['unknown', 'welcome']]) {
    assert.equal(restoreOnboardingStep(target, 'user1', { getItem: () => saved }), expected)
  }
})
