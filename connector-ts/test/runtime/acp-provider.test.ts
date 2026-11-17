import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { RuntimeEvent } from '../../src/application/ports/runtime-session.js'
import { RuntimeFailure } from '../../src/runtime/acp/errors.js'
import { checkDefinition, instanceSchema, type AcpAgentDefinition } from '../../src/runtime/profiles/definition.js'
import { genericDialect } from '../../src/runtime/profiles/generic/dialect.js'
import { HERMES, hermesProvider } from '../../src/runtime/profiles/hermes/index.js'
import { candidates, expandPath, localLaunch, type Platform } from '../../src/runtime/profiles/launch.js'

const agentScript = fileURLToPath(new URL('../support/fake-acp-process.mjs', import.meta.url))
const posix = process.platform !== 'win32'

let root: string
let bin: string
let home: string

/** Fake `hermes`: `acp --check` exits with FAKE_CHECK_EXIT, `acp --version` prints two lines, `acp` starts the fake ACP Agent. */
function installFakeHermes(directory: string): string {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'hermes')
  writeFileSync(path, [
    '#!/bin/sh',
    'if [ "$2" = "--check" ]; then exit "${FAKE_CHECK_EXIT:-0}"; fi',
    'if [ "$2" = "--version" ]; then echo "Hermes Agent"; echo "hermes 0.9.1"; exit 0; fi',
    `exec "${process.execPath}" "${agentScript}"`,
    '',
  ].join('\n'))
  chmodSync(path, 0o755)
  return path
}

function platform(env: NodeJS.ProcessEnv = {}): Platform {
  return { platform: process.platform, home, env: { PATH: bin, ...env } }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aa-provider-')))
  bin = join(root, 'bin')
  home = join(root, 'home')
  mkdirSync(bin)
  mkdirSync(home)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('ACP Agent definitions', () => {
  it('builds the v2 instance schema and refuses launch instructions in configuration', () => {
    const schema = instanceSchema(HERMES).schema as { additionalProperties: boolean; properties: Record<string, unknown> }
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties)).toEqual(['cliPath', 'hermesHome'])
    expect(() => checkDefinition(HERMES)).not.toThrow()
    const bad: AcpAgentDefinition = { ...HERMES, settings: [{ key: 'Env', title: 'x', environment: 'X' }] }
    expect(() => checkDefinition(bad)).toThrow(/must not contain/)
    const open: AcpAgentDefinition = { ...HERMES, configSchema: { schema: { type: 'object', properties: {} } } }
    expect(() => checkDefinition(open)).toThrow(/reject unknown fields/)
  })

  it('rejects unknown or oversized settings without echoing the value', () => {
    const provider = hermesProvider()
    expect(() => provider.validateSettings({ command: 'rm -rf /' })).toThrow(RuntimeFailure)
    try {
      provider.validateSettings({ cliPath: 'x'.repeat(5000) })
    } catch (error) {
      expect((error as RuntimeFailure).error.code).toBe('invalid_config')
      expect((error as Error).message).not.toContain('xxxx')
    }
  })
})

describe('local launch', () => {
  it('expands ~ and environment variables like os.path', () => {
    expect(expandPath('~/x', platform())).toBe(join(home, 'x'))
    expect(expandPath('$HOME_X/y', platform({ HOME_X: '/h' }))).toBe('/h/y')
    expect(expandPath('${MISSING}/y', platform())).toBe('${MISSING}/y')
  })

  it.skipIf(!posix)('finds the executable on PATH, then in the candidates', async () => {
    const onPath = installFakeHermes(bin)
    expect(candidates(HERMES, platform())[0]).toBe(onPath)
    rmSync(onPath)
    const fallback = installFakeHermes(join(home, '.local', 'bin'))
    const launch = await localLaunch(HERMES, {}, platform())
    expect(launch.command).toBe(fallback)
    expect(launch.args).toEqual(['acp'])
    expect(launch.version).toBe('hermes 0.9.1')
    expect(launch.releaseId).toBe('hermes-hermes 0.9.1')
  })

  it.skipIf(!posix)('reports a missing CLI or a broken ACP entry as definite failures', async () => {
    await expect(localLaunch(HERMES, {}, platform())).rejects.toMatchObject({ error: { code: 'agent_cli_missing' } })
    await expect(localLaunch(HERMES, { cliPath: 'relative/hermes' }, platform())).rejects.toMatchObject({ error: { code: 'agent_cli_missing' } })
    installFakeHermes(bin)
    await expect(localLaunch(HERMES, {}, platform({ FAKE_CHECK_EXIT: '3' }))).rejects.toMatchObject({ error: { code: 'agent_acp_unavailable' } })
  })

  it.skipIf(!posix)('maps path settings to their environment variables', async () => {
    installFakeHermes(bin)
    const launch = await localLaunch(HERMES, { hermesHome: '~/hermes-home' }, platform())
    expect(launch.environment).toEqual({ HERMES_HOME: join(home, 'hermes-home') })
  })
})

describe('Hermes provider', () => {
  it('discovers a missing install without throwing', async () => {
    const facts = await hermesProvider({ platform: platform() }).discover()
    expect(facts).toMatchObject({ type: 'hermes', displayName: 'Hermes', installed: false, instancePolicy: 'multiple', processScope: 'shared' })
    expect(facts.problems[0]?.code).toBe('agent_cli_missing')
  })

  it.skipIf(!posix)('discovers the version, starts the process and keeps AA credentials out of it', async () => {
    installFakeHermes(bin)
    const env = { ...platform().env, AA_SECRET: 'nope', AGENTS_ANYWHERE_TOKEN: 'nope' }
    const provider = hermesProvider({ platform: { ...platform(), env }, dataDir: home })
    const facts = await provider.discover()
    expect(facts).toMatchObject({ installed: true, agentVersion: 'hermes 0.9.1', problems: [] })

    const handle = await provider.start({ instanceId: 'i1', sessionNamespace: 'ns', settings: { hermesHome: join(home, 'hh') } })
    const session = await handle.open({ kind: 'new', spec: { cwd: home } }, { sessionId: 'aa_p1', replay: 'none' })
    const events: RuntimeEvent[] = []
    const done = (async () => {
      for await (const event of session.events) {
        events.push(event)
        if (event.type === 'turn.ended') return
      }
    })()
    expect((await session.prompt({ text: 'env?' }, { deliveryId: 'd', clientMessageId: 'c' })).outcome).toBe('accepted')
    await done
    const reply = events.filter((e): e is Extract<RuntimeEvent, { type: 'message.delta' }> => e.type === 'message.delta').map(e => e.text).join('')
    expect(JSON.parse(reply)).toEqual({ HERMES_HOME: join(home, 'hh'), AA_SECRET: null, AGENTS_ANYWHERE_TOKEN: null, cwd: home })
    await handle.stop()
  })

  it.skipIf(!posix)('refuses a Hermes without a model option', async () => {
    installFakeHermes(bin)
    const provider = hermesProvider({ platform: platform({ FAKE_NO_MODEL: '1' }), dataDir: home })
    const handle = await provider.start({ instanceId: 'i1', sessionNamespace: 'ns', settings: {} })
    await expect(handle.open({ kind: 'new', spec: { cwd: home } }, { sessionId: 'aa_p2', replay: 'none' })).rejects.toMatchObject({ error: { code: 'agent_version_unsupported' } })
    await handle.stop()
  })
})

describe('generic dialect', () => {
  it('derives capabilities from the handshake only', () => {
    const items = genericDialect('opencode').capabilities({
      protocolVersion: 1, agentInfo: {}, authMethods: [], meta: {},
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { list: {} } },
    })
    const by = Object.fromEntries(items.map(c => [c.id, c.supported]))
    expect(by).toMatchObject({ 'session.list': true, 'session.fork': false, 'session.history.native': true, 'runtime.attachment': true, 'session.steer': false })
  })
})
