import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const dom = new JSDOM('<div id="root"></div>', { url: 'http://fixture' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true
function load(name, stubs) {
  const source = ts.transpileModule(readFileSync(new URL('../src/components/session/' + name, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  const context = vm.createContext({ exports: {}, require: name => stubs[name] ?? require(name), localStorage: dom.window.localStorage, crypto: webcrypto,
    window: { setInterval: () => 1, clearInterval() {}, setTimeout } })
  vm.runInContext(source, context)
  return context.exports
}
const operation = id => ({ id, kind: 'creation', state: { phase: 'cancelled', interactions: [{ title: 'private-' + id }] } })
async function accountSwitch(action, fail) {
  const pending = []
  const defer = () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
  const hook = load('use-session-creation.ts', {
    'next-intl': { useTranslations: () => key => key },
    '@/features/dashboard/runtime-workflows': { workflowApi: { cancel: defer, respond: defer, get: defer } },
    '@/lib/api': { apiClient: {} }, '@/lib/api/errors': {}, './creation-configuration': {}, '@/features/dashboard/api': {},
    './session-creation': { releaseCreationAttachments() {} },
  })
  let api
  function Probe({ options }) { api = hook.useSessionCreation(options); return null }
  const root = createRoot(document.getElementById('root'))
  const options = user => ({ userId: user, token: user + '-token', storageScope: user, removeLocal() {} })
  try {
    await React.act(() => root.render(React.createElement(Probe, { options: options('old') })))
    let oldRequest
    await React.act(() => { oldRequest = action === 'cancel' ? api.cancelWorkflow(operation('old'))
      : action === 'respond' ? api.respondWorkflow(operation('old'), {}, 'submit') : api.refreshWorkflow(operation('old')) })
    await React.act(() => root.render(React.createElement(Probe, { options: options('new') })))
    let newRequest
    await React.act(() => { newRequest = api.cancelWorkflow(operation('new')) })
    await React.act(async () => { fail ? pending[0].reject(new Error('old private failure')) : pending[0].resolve(operation('old')); await oldRequest })
    assert.deepEqual(Object.keys(api.workflowCreations), [])
    assert.equal(api.workflowError, undefined)
    assert.equal(api.workflowPending, true, 'old completion must not unlock a new request')
    await React.act(async () => { pending[1].resolve(operation('new')); await newRequest })
    assert.deepEqual(Object.keys(api.workflowCreations), ['new'])
    assert.equal(api.workflowPending, false)
  } finally { await React.act(() => root.unmount()) }
}

try {
  for (const action of ['cancel', 'respond', 'refresh']) for (const fail of [false, true]) await accountSwitch(action, fail)
  console.log('Runtime workflow account isolation (success/error/cancel/reply/query): passed')
} finally { dom.window.close() }
