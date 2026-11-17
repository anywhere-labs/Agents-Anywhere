// ported from Agents-Anywhere v2 connector/tests/test_pi_native_history.py @98dd0e6e5 (engine-independent parts)

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { piHistoryItemId } from '../../src/domain/identity/index.js'
import { RuntimeFailure } from '../../src/runtime/acp/errors.js'
import { PiNativeIndex, piTimeline, readPiHistory } from '../../src/runtime/companions/native-history/index.js'
import { BRIDGE_TEMPLATE, patchSources, prepareAdapter } from '../../src/runtime/profiles/pi/adapter.js'
import { GUARD } from '../../src/runtime/profiles/pi/dialect.js'
import { probeSdk, resolveLocal, sdkVersionSupported } from '../../src/runtime/profiles/pi/installation.js'
import { DEPENDENCIES, sourceChanged } from '../../src/runtime/profiles/pi/launch.js'
import { normalizePiSettings, prepareManagedSettings, updateDefaultModel } from '../../src/runtime/profiles/pi/settings.js'
import { npmRuntimeIdentity } from '../../src/runtime/supervisor/npm-runtime.js'

const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'aa-pi-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const code = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise
    return undefined
  } catch (error) {
    if (error instanceof RuntimeFailure) return error.error.code
    throw error
  }
}

function historyFile(root: string, cwd: string, options: { name?: string; nativeId?: string; version?: number } = {}): string {
  mkdirSync(root, { recursive: true })
  const path = join(root, `${options.name ?? 'history'}.jsonl`)
  const records = [
    { type: 'session', version: options.version ?? 3, id: options.nativeId ?? 'native-session', cwd, timestamp: '2026-10-30T00:00:00Z' },
    { type: 'message', id: 'user1', parentId: null, message: { role: 'user', content: 'original question' } },
    { type: 'message', id: 'assistant1', parentId: 'user1', message: { role: 'assistant', content: [{ type: 'text', text: 'original reply' }] } },
  ]
  writeFileSync(path, records.map(record => JSON.stringify(record) + '\n').join(''))
  return path
}

describe('Pi native history (read-only)', () => {
  it('is read-only and stable', async () => {
    const root = temp()
    const path = historyFile(join(root, 'sessions'), root)
    const before = readFileSync(path)
    const first = piTimeline(await readPiHistory(path, [join(root, 'sessions')]), 'platform-session')
    const second = piTimeline(await readPiHistory(path, [join(root, 'sessions')]), 'platform-session')
    expect(first).toEqual(second)
    expect(first.map(item => item.content.text)).toEqual(['original question', 'original reply'])
    expect(first[0]!.id).toBe(piHistoryItemId('platform-session', { id: 'user1' }, 0, 0))
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  it('does not claim a partial history is complete', async () => {
    const root = temp()
    const path = historyFile(root, root)
    appendFileSync(path, '{"type":"message","id":')
    const history = await readPiHistory(path, [root])
    expect(history.complete).toBe(false)
    expect(piTimeline(history, 'p')).toHaveLength(2)
    expect(() => history.requireResumable()).toThrow(/正在写入/)
  })

  it('browses legacy history without migration', async () => {
    const root = temp()
    const path = historyFile(root, root, { version: 2 })
    const history = await readPiHistory(path, [root])
    expect(piTimeline(history, 'p')).toHaveLength(2)
    expect(() => history.requireResumable()).toThrow(/迁移/)
  })

  it('does not follow a symlink out of the source', async () => {
    const root = temp()
    const outside = historyFile(join(root, 'outside'), root)
    mkdirSync(join(root, 'source'))
    symlinkSync(outside, join(root, 'source', 'escape.jsonl'))
    expect(await code(readPiHistory(join(root, 'source', 'escape.jsonl'), [join(root, 'source')]))).toBe('pi_history_outside_source')
    const index = new PiNativeIndex(() => [join(root, 'source')])
    expect((await index.list()).sessions).toEqual([])
  })

  it('keeps branches and compaction as original nodes', async () => {
    const root = temp()
    const path = historyFile(root, root)
    appendFileSync(path, [
      { type: 'message', id: 'branch', parentId: 'user1', message: { role: 'assistant', content: 'other branch' } },
      { type: 'compaction', id: 'compaction', parentId: 'branch', summary: 'summary' },
    ].map(record => JSON.stringify(record) + '\n').join(''))
    const items = piTimeline(await readPiHistory(path, [root]), 'p')
    expect(items).toHaveLength(4)
    expect(items[2]!.source.parentId).toBe('user1')
    expect(items[3]!.content.nativeEntryType).toBe('compaction')
  })

  it('gives repeated legacy messages distinct stable ids', async () => {
    const root = temp()
    const path = historyFile(root, root, { version: 1 })
    const entry = JSON.stringify({ type: 'message', message: { role: 'user', content: 'same text' } }) + '\n'
    appendFileSync(path, entry + entry)
    const items = piTimeline(await readPiHistory(path, [root]), 'p')
    expect(new Set(items.map(item => item.id)).size).toBe(4)
  })

  it('keeps the AA presentation of user messages without execution paths', async () => {
    const root = temp()
    const path = historyFile(root, root)
    const attachment = { fileId: 'file_note', name: 'note.txt', mediaType: 'text/plain' }
    appendFileSync(path, JSON.stringify({
      type: 'message', id: 'attached', parentId: 'assistant1', message: {
        role: 'user', content: [{ type: 'text', text: 'read\n[resource_link name="note.txt" path="/private/cache/file"]' }],
        aaClientMessageId: 'attached-id', aaDisplayText: 'read', aaAttachments: [attachment],
      },
    }) + '\n')
    const item = piTimeline(await readPiHistory(path, [root]), 'p').at(-1)!
    expect(item.content).toMatchObject({ text: 'read', attachments: [attachment], clientMessageId: 'attached-id' })
    expect(item.source.clientMessageId).toBe('attached-id')
  })

  it('titles a session by its first user text without execution paths', async () => {
    const root = temp()
    const path = historyFile(root, root)
    const lines = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, Record<string, unknown>>)
    lines[1]!.message = { role: 'user', content: 'clean title\n[resource_link path="/private"]', aaDisplayText: 'clean title' }
    writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
    expect((await readPiHistory(path, [root])).title).toBe('clean title')
  })

  it('marks sessions with the same identity in two files as ambiguous', async () => {
    const root = temp()
    historyFile(join(root, 'a'), root, { name: 'one' })
    historyFile(join(root, 'b'), root, { name: 'two' })
    const index = new PiNativeIndex(() => [root])
    expect((await index.scan()).every(source => source.ambiguous)).toBe(true)
    expect(await code(index.find({ nativeSessionId: 'native-session' }))).toBe('pi_source_ambiguous')
  })
})

/** A fake adapter release that is complete enough to patch (`adapter_release`). */
function adapterRelease(root: string, options: { version?: string; steer?: boolean } = {}): string {
  const dist = join(root, 'pi-acp', 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(root, 'pi-acp', 'package.json'), JSON.stringify({ version: options.version ?? '0.1.9' }))
  const source = 'import {x} from "@earendil-works/pi-coding-agent";\n'
    + 'async function findSession(sessionId, sessionDir) { return {}; }\n'
    + 'await session.prompt(converted.text, converted.images)\n'
    + (options.steer === false ? '' : 'await session.steer(converted.text, converted.images)\n')
    + 'return buildConfigOptions(this.session, {\n      booleanOptions: this.features.booleanConfigOptions\n    });\n'
    + 'extensions: session.extensions(),\n'
    + 'await this.requireModel(session).catch((error) => {\n      throw error;\n    });\n'.repeat(3)
  writeFileSync(join(dist, 'chunk-NEWBUILD.js'), source)
  writeFileSync(join(dist, 'bin.js'), 'import "./chunk-NEWBUILD.js";\n')
  mkdirSync(join(root, 'node_modules'))
  return join(dist, 'bin.js')
}

describe('Pi adapter patch', () => {
  it('follows new releases by anchor and reuses a verified cache', async () => {
    const root = temp()
    const entry = adapterRelease(root)
    const first = await prepareAdapter(entry, join(root, 'sdk'), join(root, 'cache'))
    const chunk = readFileSync(join(first.entry, '..', 'chunk-NEWBUILD.js'), 'utf8')
    expect(chunk.startsWith('import {aaFindSession')).toBe(true)
    expect(chunk).toContain('aaWithMessage(params, () => session.steer')
    expect(chunk.split('await this.requireModel(session);').length - 1).toBe(3)
    expect(chunk).not.toContain('"@earendil-works/pi-coding-agent"')
    expect(first.metadata.version).toBe('0.1.9')
    expect(Object.keys(first.metadata.sourceFiles as object).sort()).toEqual(['bin.js', 'chunk-NEWBUILD.js'])
    expect(readFileSync(join(first.entry, '..', '..', 'sdk-bridge.mjs'), 'utf8')).toContain(pathToFileURL(join(root, 'sdk', 'dist/index.js')).href)
    const second = await prepareAdapter(entry, join(root, 'sdk'), join(root, 'cache'))
    expect(second.entry).toBe(first.entry)
    // refuse a cache that was modified
    writeFileSync(join(first.entry, '..', 'chunk-NEWBUILD.js'), 'tampered')
    expect(await code(prepareAdapter(entry, join(root, 'sdk'), join(root, 'cache')))).toBe('pi_adapter_cache_corrupt')
  })

  it.each([
    [{ steer: false }, 'pi_adapter_patch_failed'],
    [{ version: '0.2.0' }, 'pi_adapter_incompatible'],
  ] as const)('refuses releases without verified entry points (%o)', async (release, expected) => {
    const root = temp()
    expect(await code(prepareAdapter(adapterRelease(root, release), join(root, 'sdk'), join(root, 'cache')))).toBe(expected)
  })

  it('needs exactly three model checks', () => {
    expect(() => patchSources({ 'a.js': 'async function findSession(sessionId, sessionDir) {}' })).toThrow(RuntimeFailure)
  })
})

describe('Pi settings and launch', () => {
  const gateway = { baseUrl: 'http://127.0.0.1:9/v1', authToken: 'secret-key', protocol: 'openai-chat' as const }

  it('keeps old gateway configurations on the managed source and rejects mismatched modes', () => {
    expect(normalizePiSettings({}, gateway).executionMode).toBe('managed')
    expect(normalizePiSettings({}, undefined).executionMode).toBe('auto')
    expect(() => normalizePiSettings({ executionMode: 'local' }, gateway)).toThrow(/本机模式/)
    expect(() => normalizePiSettings({ executionMode: 'managed' }, undefined)).toThrow(/受管环境需要/)
    expect(() => normalizePiSettings({}, { ...gateway, protocol: 'anthropic' })).toThrow(/OpenAI/)
    expect(() => normalizePiSettings({ customModels: [{ modelId: 'a', displayName: 'A' }, { modelId: 'a', displayName: 'B' }] }, undefined)).toThrow(/duplicate/)
    expect(() => normalizePiSettings({ executionMode: 'cloud' }, undefined)).toThrow(RuntimeFailure)
  })

  it('writes a private managed configuration without the gateway key', async () => {
    const root = temp()
    const settings = normalizePiSettings({ customModels: [{ modelId: 'm1', displayName: 'M1' }, { modelId: 'm2', displayName: 'M2', efforts: [{ effortId: 'high', displayName: 'High' }] }] }, gateway)
    const agentDir = await prepareManagedSettings(root, settings, { ...gateway, model: 'm2' }, { guard: GUARD })
    const models = readFileSync(join(agentDir, 'models.json'), 'utf8')
    expect(models).not.toContain('secret-key')
    expect(JSON.parse(models).providers.aa).toMatchObject({ baseUrl: gateway.baseUrl, api: 'openai-completions', apiKey: '${AA_PI_GATEWAY_KEY}' })
    expect(JSON.parse(models).providers.aa.models.map((m: { id: string; reasoning: boolean }) => [m.id, m.reasoning])).toEqual([['m1', false], ['m2', true]])
    expect(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))).toEqual({ defaultProvider: 'aa', defaultModel: 'm2', extensions: [GUARD] })
    await updateDefaultModel(agentDir, 'm1')
    expect(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).defaultModel).toBe('m1')
  })

  it('reads the model list from the gateway when none is configured', async () => {
    const root = temp()
    const calls: string[] = []
    const fetchStub = (async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push(`${url} ${init?.headers?.Authorization}`)
      return new Response(JSON.stringify({ data: [{ id: 'gw-1' }, { id: 2 }] }))
    }) as unknown as typeof fetch
    const agentDir = await prepareManagedSettings(root, normalizePiSettings({}, gateway), gateway, { guard: GUARD, fetch: fetchStub })
    expect(calls).toEqual(['http://127.0.0.1:9/v1/models Bearer secret-key'])
    expect(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).defaultModel).toBe('gw-1')
    const failing = (async () => new Response('', { status: 500 })) as unknown as typeof fetch
    expect(await code(prepareManagedSettings(temp(), normalizePiSettings({}, gateway), gateway, { guard: GUARD, fetch: failing }))).toBe('pi_models_unavailable')
  })

  it('treats upgrades as the same source but not a mode or directory change', () => {
    const local = { mode: 'local', agentDir: '/home/pi', installation: { version: '1.4.0' } }
    const upgraded = { ...local, installation: { version: '1.5.0' }, adapter: { version: '0.1.9' } }
    expect(sourceChanged(undefined, local)).toBe(false)
    expect(sourceChanged(local, upgraded)).toBe(false)
    expect(sourceChanged(local, { ...upgraded, agentDir: '/elsewhere' })).toBe(true)
    expect(sourceChanged(local, { ...upgraded, mode: 'managed' })).toBe(true)
    const managed = { mode: 'managed', agentDir: '/aa/rev1' }
    expect(sourceChanged(managed, { ...managed, agentDir: '/aa/rev2' })).toBe(false)
  })

  it('installs into the same directory as v2 for the same dependency list', () => {
    expect(npmRuntimeIdentity(DEPENDENCIES)).toBe('2a767d2905f93e2908db')
  })
})

const posix = process.platform !== 'win32'

/** A fake Pi SDK (`fake_sdk`). */
function fakeSdk(root: string, managerMethods = '_persist(){} _rewriteFile(){} getSessionFile(){} getSessionId(){}'): string {
  const sdk = join(root, 'sdk')
  mkdirSync(join(sdk, 'dist'), { recursive: true })
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.9.0', type: 'module' }))
  writeFileSync(join(sdk, 'dist/index.js'), "export const VERSION = '1.9.0';\nexport function createAgentSessionServices() {}\nexport function createAgentSessionFromServices() {}\n"
    + `export class SessionManager { static open(){} static create(){} static forkFrom(){} ${managerMethods} }\n`)
  const core = join(sdk, 'node_modules/@earendil-works/pi-agent-core')
  mkdirSync(core, { recursive: true })
  writeFileSync(join(core, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-agent-core', type: 'module', exports: { '.': { import: './index.js' }, './package.json': './package.json' } }))
  writeFileSync(join(core, 'index.js'), 'export class Agent { prompt(){} steer(){} followUp(){} normalizePromptInput(){} }\n')
  return sdk
}

describe('Pi installation', () => {
  it('accepts the verified SDK major range', () => {
    expect(['1.2.0', '1.4.0', '1.9.3-beta'].map(sdkVersionSupported)).toEqual([true, true, true])
    expect(['1.1.0', '2.0.0', '1.4', 'x', null].map(sdkVersionSupported)).toEqual([false, false, false, false, false])
  })

  it.skipIf(!posix)('binds a local CLI to its own exported SDK and refuses wrappers and old SDKs', async () => {
    const root = temp()
    const sdk = join(root, 'lib/node_modules/@earendil-works/pi-coding-agent')
    mkdirSync(join(sdk, 'dist/bundle'), { recursive: true })
    writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.4.0' }))
    writeFileSync(join(sdk, 'dist/index.js'), "export const VERSION='1.4.0'")
    writeFileSync(join(sdk, 'dist/bundle/cli.js'), '// native CLI')
    mkdirSync(join(root, 'bin'))
    symlinkSync(join(sdk, 'dist/bundle/cli.js'), join(root, 'bin/pi'))
    symlinkSync(process.execPath, join(root, 'bin/node'))
    const env = { ...process.env, PATH: join(root, 'bin') }
    const installation = await resolveLocal({}, { env, home: root })
    expect(installation.sdk).toBe(execFileSync('realpath', [sdk], { encoding: 'utf8' }).trim())
    expect(installation.version).toBe('1.4.0')
    rmSync(join(root, 'bin/pi'))
    writeFileSync(join(root, 'bin/pi'), '#!/bin/sh\nexec some-other-pi "$@"\n')
    expect(await code(resolveLocal({}, { env, home: root }))).toBe('pi_installation_unsupported')
    writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.1.0' }))
    const old = resolveLocal({ cliPath: join(sdk, 'dist/bundle/cli.js') }, { env, home: root })
    await expect(old).rejects.toThrow(/1\.1\.0 不受支持.*>=1\.2\.0 <2/)
  })

  it('names the SDK entry points AA needs', async () => {
    const root = temp()
    const sdk = fakeSdk(root)
    await probeSdk({ cli: sdk, node: process.execPath, sdk, version: '1.9.0' })
    const changed = fakeSdk(join(root, 'changed'), 'getSessionFile(){} getSessionId(){}')
    await expect(probeSdk({ cli: changed, node: process.execPath, sdk: changed, version: '1.9.0' })).rejects.toThrow(/1\.9\.0 缺少.*SessionManager#_persist.*SessionManager#_rewriteFile/)
    writeFileSync(join(changed, 'dist/index.js'), "throw new Error('broken dependency')")
    await expect(probeSdk({ cli: changed, node: process.execPath, sdk: changed, version: '1.9.0' })).rejects.toThrow(/无法加载 Pi 1\.9\.0 的 SDK：broken dependency/)
  })
})

const runNode = (script: string, ...args: string[]): void => {
  execFileSync(process.execPath, ['--input-type=module', '-e', script, ...args], { timeout: 20_000, stdio: 'pipe' })
}

describe('Pi guard and SDK bridge', () => {
  it('blocks tools and user bash when the approval channel is lost', () => {
    runNode(`
const {default:guard}=await import(process.argv[1]);
const handlers={};guard({on:(name,handler)=>handlers[name]=handler});
const ctx={sessionManager:{getSessionId:()=> 'session'},ui:{confirm:async()=>{throw new Error('channel lost')}}};
const tool=await handlers.tool_call({toolName:'write',toolCallId:'call',input:{}},ctx);
const bash=await handlers.user_bash({command:'touch forbidden'},ctx);
if(tool.block!==true||bash.result.exitCode!==1)process.exit(1);
`, pathToFileURL(GUARD).href)
  })

  function bridge(root: string, sdkSource: string): string {
    writeFileSync(join(root, 'sdk.mjs'), sdkSource)
    const path = join(root, 'bridge.mjs')
    writeFileSync(path, readFileSync(BRIDGE_TEMPLATE, 'utf8').replaceAll('__AA_PI_SDK_URL__', pathToFileURL(join(root, 'sdk.mjs')).href))
    return pathToFileURL(path).href
  }

  it('binds the AA identity to each queued message', () => {
    const url = bridge(temp(), `
export class SessionManager {}
export const VERSION='fixture';
export async function createAgentSessionFromServices() {
 const messages=[];
 return {session:{agent:{messages,normalizePromptInput:x=>typeof x==='string'?[{role:'user',content:[{type:'text',text:x}]}]:Array.isArray(x)?x:[x],prompt:async xs=>messages.push(...xs),steer:m=>messages.push(m),followUp:m=>messages.push(m)}}};
}
`)
    runNode(`
import assert from 'node:assert/strict';
const {aaWithMessage,createAgentSessionFromServices}=await import(process.argv[1]);
const {session:{agent}}=await createAgentSessionFromServices({});
const attachment={fileId:'file_note',name:'note.txt',mediaType:'text/plain'};
await Promise.all(['original','steer-one','steer-two'].map(id=>aaWithMessage({_meta:{aa:{clientMessageId:id}},prompt:[{type:'text',text:id},{type:'resource_link',_meta:{aa:{attachment}}}]},async()=>{
 await Promise.resolve();
 if(id==='original')await agent.prompt('expanded original');
 else agent.steer({role:'user',content:[{type:'text',text:'same expanded text'}]});
})));
assert.deepEqual(agent.messages.map(m=>m.aaClientMessageId),['original','steer-one','steer-two']);
assert.deepEqual(agent.messages.map(m=>m.aaDisplayText),['original','steer-one','steer-two']);
assert.deepEqual(agent.messages[2].aaAttachments,[attachment]);
agent.steer({role:'user',content:[]});
assert.equal(agent.messages[3].aaClientMessageId,undefined);
`, url)
  })

  it('refuses to resume a native file that changed before the process opened it', () => {
    const root = temp()
    const file = join(root, 'session.jsonl')
    writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: 'native', cwd: root }) + '\n')
    const url = bridge(root, `
export class SessionManager { static open(path){ return {path,getSessionFile(){return path},getSessionId(){return 'native'},_persist(){},_rewriteFile(){}} } }
export const VERSION='fixture';
`)
    const digest = 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex')
    const script = `
const {SessionManager}=await import(process.argv[1]);
try { SessionManager.open(process.argv[2]); console.log('opened') } catch (error) { console.log(String(error.message)) }
`
    const run = (revision: string): string => execFileSync(process.execPath, ['--input-type=module', '-e', script, url, file], {
      env: { ...process.env, AA_PI_SESSION_FILE: file, AA_PI_SESSION_ID: 'native', AA_PI_SOURCE_REVISION: revision, AA_PI_WRITE_STATE: join(root, 'state.json') },
      encoding: 'utf8', timeout: 20_000,
    }).trim()
    expect(run(digest)).toBe('opened')
    expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))).toMatchObject({ revision: digest, conflict: false, sessionId: 'native' })
    expect(run('sha256:other')).toContain('pi_source_conflict')
  })
})
