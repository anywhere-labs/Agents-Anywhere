import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  RuntimeLease,
  arbitrate,
  commandDigest,
  compareVersions,
  dataDir,
  legacyDataDir,
  identityMatches,
  isV2ConnectorCommand,
  legacyIdentity,
  parseLstart,
  readRuntimeState,
  runtimeTransaction,
  systemProbe,
  ticksToEpoch,
  type ProcessProbe,
} from '../../src/host/index.js'

let home: string
let record: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aa-host-'))
  mkdirSync(join(home, '.agents-anywhere'))
  record = join(home, '.agents-anywhere', 'connector-runtime.json')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** Processes by pid: start time (epoch seconds) and command line. */
function fakeProbe(processes: Record<number, { started: number; command: string }>): ProcessProbe {
  return {
    exists: pid => pid in processes,
    startedAt: async pid => processes[pid]?.started ?? null,
    commandLine: async pid => processes[pid]?.command ?? null,
  }
}

const v3 = (version: string, schemaVersion = 1) => ({ kind: 'cli' as const, version, schemaVersion })

describe('process identity', () => {
  it('writes the v2 legacy identity and reads every recorded form', () => {
    const started = Date.UTC(2026, 10, 16, 22, 40, 1) / 1000
    expect(legacyIdentity(started)).toBe('Mon Nov 16 22:40:01 2026')
    expect(parseLstart('Mon Nov  16 22:40:01 2026\n')).toBe(started)
    expect(identityMatches('Mon Nov 16 22:40:01 2026', started)).toBe(true)
    expect(identityMatches(`unix:${started}.371245`, started)).toBe(true)
    expect(identityMatches(`unix:${started + 30}.0`, started)).toBe(false)
    const ticks = (BigInt(started) * 10_000_000n + 621355968000000000n).toString()
    expect(ticksToEpoch(ticks)).toBe(started)
    expect(identityMatches(ticks, started)).toBe(true)
  })

  it('recognises v2 entry points only', () => {
    expect(isV2ConnectorCommand('/usr/local/bin/anywhere-cli start')).toBe(true)
    expect(isV2ConnectorCommand('/opt/venv/bin/python3 -m connector.cli rpc')).toBe(true)
    expect(isV2ConnectorCommand('C:\\venv\\Scripts\\agent-connector.exe')).toBe(true)
    expect(isV2ConnectorCommand('/usr/bin/python3 /srv/connector/cli.py')).toBe(true)
    expect(isV2ConnectorCommand('/usr/bin/python3 -c "import connector"')).toBe(false)
    expect(isV2ConnectorCommand('/usr/bin/node server.js')).toBe(false)
  })

  it('inspects this process', async () => {
    expect(systemProbe.exists(process.pid)).toBe(true)
    expect(systemProbe.exists(2 ** 22 + 12345)).toBe(false)
    const started = await systemProbe.startedAt(process.pid)
    expect(started).not.toBeNull()
    expect(Math.abs(started! - (Date.now() / 1000 - process.uptime()))).toBeLessThan(5)
    expect(await systemProbe.commandLine(process.pid)).toMatch(/node/iu)
  })
})

describe('runtime record', () => {
  it('reads absent, pre-v2 and v2 records and refuses unknown versions', async () => {
    expect(await readRuntimeState(record)).toEqual({ version: 2, connectorIds: [] })
    writeFileSync(record, JSON.stringify({ pid: 12, kind: 'cli', connectorId: 'conn_a' }))
    expect(await readRuntimeState(record)).toMatchObject({ connectorIds: ['conn_a'], runtime: { instanceId: 'legacy-12', pid: 12 } })
    writeFileSync(record, JSON.stringify({ version: 3 }))
    await expect(readRuntimeState(record)).rejects.toMatchObject({ code: 'runtime_record_invalid' })
    writeFileSync(record, '{not json')
    await expect(runtimeTransaction(record, () => undefined)).rejects.toMatchObject({ code: 'runtime_record_invalid' })
    expect(readFileSync(record, 'utf8')).toBe('{not json')
  })

  it('keeps unknown fields and serialises concurrent transactions', async () => {
    writeFileSync(record, JSON.stringify({ version: 2, connectorIds: [], desktop: { appPath: '/A' }, counter: 0 }))
    await Promise.all(Array.from({ length: 5 }, () => runtimeTransaction(record, state => {
      state.counter = (state.counter as number) + 1
    })))
    const state = JSON.parse(readFileSync(record, 'utf8'))
    expect(state).toMatchObject({ version: 2, desktop: { appPath: '/A' }, counter: 5, legacyMachineMigrated: true })
    expect(existsSync(`${record}.lock.json`)).toBe(false)
  })

  it('takes over the lock record of a writer that is gone', async () => {
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    await new Promise<void>(resolve => server.close(() => resolve()))
    writeFileSync(`${record}.lock.json`, JSON.stringify({ version: 1, port, pid: 1, token: 'dead', startedAt: 'x' }))
    await runtimeTransaction(record, state => {
      state.touched = true
    })
    expect(JSON.parse(readFileSync(record, 'utf8')).touched).toBe(true)
  })

  it('folds the legacy machine and installation records in once', async () => {
    const legacyDir = join(home, '.agentsanywhere')
    mkdirSync(join(legacyDir, 'desktop'), { recursive: true })
    writeFileSync(join(legacyDir, 'machine.json'), JSON.stringify({ version: 1, connectorIds: ['conn_old'] }))
    writeFileSync(join(legacyDir, 'desktop', 'install.json'), JSON.stringify({ version: 1, appPath: '/Old' }))
    writeFileSync(record, JSON.stringify({ version: 2, connectorIds: ['conn_new'] }))
    await runtimeTransaction(record, () => undefined)
    expect(JSON.parse(readFileSync(record, 'utf8'))).toMatchObject({ version: 2, connectorIds: ['conn_old', 'conn_new'], desktop: { version: 1, appPath: '/Old' }, legacyMachineMigrated: true })
    expect(existsSync(join(legacyDir, 'machine.json'))).toBe(false)
  })
})

describe('single-instance lease', () => {
  it('claims, appends the connector id once and releases only its own record', async () => {
    const probe = fakeProbe({ 100: { started: 1000, command: 'node aa connector' } })
    const lease = new RuntimeLease({ path: record, identity: v3('3.0.0'), probe, pid: 100 })
    expect(await lease.claim({ connectorId: 'conn_1', serverUrl: 'https://s' })).toEqual({ ok: true })
    await lease.claim({ connectorId: 'conn_1' })
    const state = await readRuntimeState(record)
    expect(state.connectorIds).toEqual(['conn_1'])
    expect(state.runtime).toMatchObject({ pid: 100, kind: 'cli', connectorVersion: '3.0.0', schemaVersion: 1, processStartedAt: legacyIdentity(1000), commandDigest: commandDigest('node aa connector'), connectorId: 'conn_1', serverUrl: 'https://s' })
    await lease.release()
    const after = await readRuntimeState(record)
    expect(after.runtime).toBeUndefined()
    expect(after.connectorIds).toEqual(['conn_1'])
  })

  it('arbitrates by version: newer takes over, older or equal uses the existing one, v2 conflicts', async () => {
    const probe = fakeProbe({ 100: { started: 1000, command: 'node old' }, 200: { started: 2000, command: 'node new' }, 300: { started: 3000, command: '/usr/bin/python3 -m connector.cli rpc' } })
    const old = new RuntimeLease({ path: record, identity: v3('3.0.1'), probe, pid: 100 })
    await old.claim()
    const newer = new RuntimeLease({ path: record, identity: v3('3.1.0'), probe, pid: 200 })
    expect(await newer.claim()).toMatchObject({ ok: false, decision: 'request_handover', owner: { pid: 100, connectorVersion: '3.0.1' } })
    const same = new RuntimeLease({ path: record, identity: v3('3.0.1'), probe, pid: 200 })
    expect(await same.claim()).toMatchObject({ ok: false, decision: 'use_existing' })
    // After the older owner hands over (releases), the newer one claims.
    await old.release()
    expect(await newer.claim()).toEqual({ ok: true })
    await newer.release()

    writeFileSync(record, JSON.stringify({ version: 2, connectorIds: [], runtime: { instanceId: 'py', kind: 'cli', pid: 300, startedAt: 'x', processStartedAt: `unix:3000.25` } }))
    await expect(newer.acquire()).rejects.toMatchObject({ code: 'connector_already_running', details: { reason: 'connector_already_running', owner: { kind: 'cli', pid: 300 }, decision: 'conflict' } })
    expect(arbitrate({ instanceId: 'x', kind: 'cli', pid: 1, startedAt: 'x', connectorVersion: '3.0.0', schemaVersion: 9 }, v3('9.0.0', 1))).toBe('use_existing')
    expect(compareVersions('3.10.0', '3.9.9')).toBe(1)
  })

  it('takes over from an owner that exited or whose pid was reused', async () => {
    const lease = new RuntimeLease({ path: record, identity: v3('3.0.0'), probe: fakeProbe({ 100: { started: 1000, command: 'node a' } }), pid: 100 })
    await lease.claim()
    // Exited.
    expect(await new RuntimeLease({ path: record, identity: v3('3.0.0'), probe: fakeProbe({ 200: { started: 2000, command: 'node b' } }), pid: 200 }).claim()).toEqual({ ok: true })
    // Pid 200 reused by another program (same start time is impossible, so change the command).
    expect(await new RuntimeLease({ path: record, identity: v3('3.0.0'), probe: fakeProbe({ 200: { started: 2000, command: 'vim' }, 300: { started: 3000, command: 'node c' } }), pid: 300 }).claim()).toEqual({ ok: true })
    // Pid 300 reused later: different start time.
    expect(await new RuntimeLease({ path: record, identity: v3('3.0.0'), probe: fakeProbe({ 300: { started: 9000, command: 'node c' }, 400: { started: 4000, command: 'node d' } }), pid: 400 }).claim()).toEqual({ ok: true })
    expect((await readRuntimeState(record)).runtime?.pid).toBe(400)
  })
})

describe('data directory', () => {
  it('defaults to ~/.agents-anywhere/v3 and honours AGENT_CONNECTOR_DATA_DIR', () => {
    expect(dataDir({}, '/h')).toBe(join('/h', '.agents-anywhere', 'v3'))
    expect(dataDir({ AGENT_CONNECTOR_DATA_DIR: '/data' }, '/h')).toBe('/data')
  })

  it('reads v2 data from AA_CONNECTOR_LEGACY_DATA_DIR, else AGENT_CONNECTOR_DATA_DIR, else ~/.agents-anywhere', () => {
    expect(legacyDataDir({}, '/h')).toBe(join('/h', '.agents-anywhere'))
    expect(legacyDataDir({ AGENT_CONNECTOR_DATA_DIR: '/data' }, '/h')).toBe('/data')
    expect(legacyDataDir({ AGENT_CONNECTOR_DATA_DIR: '/data', AA_CONNECTOR_LEGACY_DATA_DIR: '/plugin/connector' }, '/h')).toBe('/plugin/connector')
    // The v3 data directory does not follow the legacy one.
    expect(dataDir({ AA_CONNECTOR_LEGACY_DATA_DIR: '/plugin/connector' }, '/h')).toBe(join('/h', '.agents-anywhere', 'v3'))
  })
})
