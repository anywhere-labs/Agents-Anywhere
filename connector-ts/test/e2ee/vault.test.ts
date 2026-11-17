import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FileDeviceSecrets,
  macKeychainVault,
  secretServiceVault,
  windowsDpapiVault,
  type CommandOutcome,
  type CommandRunner,
  type VaultKeyProvider,
} from '../../src/keystore/index.js'

interface Call {
  readonly file: string
  readonly args: readonly string[]
  readonly input: string
  readonly detached: boolean
}

/** A command runner that answers from `respond` and records every call. */
function fakeRunner(respond: (file: string, args: readonly string[], input: string) => Partial<CommandOutcome> | Error) {
  const calls: Call[] = []
  const run: CommandRunner = async (file, args, options = {}) => {
    calls.push({ file, args, input: options.input ?? '', detached: options.detached ?? false })
    const answer = respond(file, args, options.input ?? '')
    if (answer instanceof Error) throw answer
    return { code: 0, stdout: '', stderr: '', ...answer }
  }
  return { run, calls }
}

const KEY = Buffer.alloc(32, 9).toString('base64')
const missing = (): Error => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })

/** An in-memory login keychain behind `security`. */
function fakeSecurity(initial: string | null, findFailure?: Partial<CommandOutcome>) {
  let stored = initial
  return fakeRunner((_file, args, input) => {
    if (args[0] === 'find-generic-password') {
      if (findFailure !== undefined) return findFailure
      return stored === null ? { code: 44, stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' } : { stdout: `${stored}\n` }
    }
    if (args[0] === 'add-generic-password') {
      if (stored !== null) return { code: 45, stderr: 'The specified item already exists in the keychain.' }
      const [first, second] = input.split('\n')
      if (first !== second) return { code: 0 }
      stored = first ?? ''
      return { code: 0 }
    }
    return { code: 1 }
  })
}

const noKeyInArgv = (calls: readonly Call[], key: string): void => {
  for (const call of calls) expect(call.args.join(' ')).not.toContain(key)
}

describe('macOS keychain vault', () => {
  it('creates a key only when the keychain reports the item missing, passing it on stdin', async () => {
    const { run, calls } = fakeSecurity(null)
    const key = await macKeychainVault('acct', run).getOrCreate()
    expect(key).toHaveLength(32)
    const encoded = Buffer.from(key!).toString('base64')
    const add = calls.find(c => c.args[0] === 'add-generic-password')!
    // `-w` last with no value, the key twice on stdin (password and confirmation), and no `-U` (never overwrite).
    expect(add.args.at(-1)).toBe('-w')
    expect(add.args).not.toContain('-U')
    expect(add.input).toBe(`${encoded}\n${encoded}\n`)
    expect(add.detached).toBe(true)
    noKeyInArgv(calls, encoded)
    // Read back after the write.
    expect(calls.map(c => c.args[0])).toEqual(['find-generic-password', 'add-generic-password', 'find-generic-password'])
  })

  it('returns the existing key without writing', async () => {
    const { run, calls } = fakeSecurity(KEY)
    expect(Buffer.from((await macKeychainVault('acct', run).getOrCreate())!).toString('base64')).toBe(KEY)
    expect(calls.map(c => c.args[0])).toEqual(['find-generic-password'])
  })

  it.each([
    ['a locked keychain without a user to unlock it', { code: 36, stderr: 'User interaction is not allowed.' }],
    ['any other failure', { code: 51, stderr: 'some error' }],
    ['a malformed stored key', { code: 0, stdout: 'not-a-key' }],
  ])('never creates or overwrites on %s', async (_name, failure) => {
    const { run, calls } = fakeSecurity(KEY, failure)
    await expect(macKeychainVault('acct', run).getOrCreate()).rejects.toMatchObject({ code: 'keystore_unavailable' })
    expect(calls.map(c => c.args[0])).toEqual(['find-generic-password'])
  })

  it('reports a missing item as null when asked not to create', async () => {
    const { run, calls } = fakeSecurity(null)
    expect(await macKeychainVault('acct', run).getOrCreate({ create: false })).toBeNull()
    expect(calls.map(c => c.args[0])).toEqual(['find-generic-password'])
  })

  it('uses the key another process added first', async () => {
    let stored: string | null = null
    const { run } = fakeRunner((_f, args) => {
      if (args[0] === 'find-generic-password') return stored === null ? { code: 44 } : { stdout: stored }
      stored = KEY // the other process won the race; this add is refused as a duplicate
      return { code: 45 }
    })
    expect(Buffer.from((await macKeychainVault('acct', run).getOrCreate())!).toString('base64')).toBe(KEY)
  })
})

describe('Secret Service vault', () => {
  it('creates a key only when lookup finds nothing, passing it on stdin', async () => {
    let stored: string | null = null
    const { run, calls } = fakeRunner((_f, args, input) => {
      if (args[0] === 'lookup') return stored === null ? { code: 1 } : { stdout: stored }
      stored = input
      return { code: 0 }
    })
    const key = await secretServiceVault('acct', run).getOrCreate()
    const encoded = Buffer.from(key!).toString('base64')
    expect(calls.find(c => c.args[0] === 'store')!.input).toBe(encoded)
    noKeyInArgv(calls, encoded)
  })

  it('fails without creating when the Secret Service cannot be reached', async () => {
    const { run, calls } = fakeRunner(() => ({ code: 1, stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY' }))
    await expect(secretServiceVault('acct', run).getOrCreate()).rejects.toMatchObject({ code: 'keystore_unavailable' })
    expect(calls.map(c => c.args[0])).toEqual(['lookup'])
  })

  it('has no protected store when secret-tool is not installed', async () => {
    const { run } = fakeRunner(() => missing())
    expect(await secretServiceVault('acct', run).getOrCreate()).toBeNull()
  })
})

describe('Windows DPAPI vault', () => {
  it('protects and unprotects through stdin, never on the command line', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aa-vault-'))
    const file = path.join(dir, 'trust', 'vault.dpapi')
    // "DPAPI": reversing the text is its own inverse, enough to see what goes where.
    const { run, calls } = fakeRunner((_f, _args, input) => ({ stdout: [...input].reverse().join('') }))
    const vault = windowsDpapiVault(file, run)
    const key = await vault.getOrCreate()
    const encoded = Buffer.from(key!).toString('base64')
    expect(await readFile(file, 'utf8')).toBe([...encoded].reverse().join(''))
    expect(await vault.getOrCreate()).toEqual(key)
    noKeyInArgv(calls, encoded)
    noKeyInArgv(calls, [...encoded].reverse().join(''))
    expect(calls.map(c => c.input)).toEqual([encoded, [...encoded].reverse().join('')])
  })

  it('fails without replacing the sealed key when DPAPI cannot open it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aa-vault-'))
    const file = path.join(dir, 'vault.dpapi')
    await writeFile(file, 'sealed-by-another-user')
    const { run, calls } = fakeRunner(() => ({ code: 1, stderr: 'Key not valid for use in specified state.' }))
    await expect(windowsDpapiVault(file, run).getOrCreate()).rejects.toMatchObject({ code: 'keystore_unavailable' })
    expect(await readFile(file, 'utf8')).toBe('sealed-by-another-user')
    expect(calls).toHaveLength(1)
  })
})

describe('device secrets with an unreachable vault', () => {
  it('never makes a new key for an existing secrets file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aa-trust-'))
    const keychain = fakeSecurity(null)
    const first = await new FileDeviceSecrets(dir, macKeychainVault('acct', keychain.run)).identityKey()
    const sealed = await readFile(path.join(dir, 'trust', 'secrets.json'), 'utf8')
    expect(JSON.parse(sealed).protection).toBe('keychain')

    // The keychain is locked now: loading fails and nothing is written.
    const locked = fakeSecurity(KEY, { code: 36, stderr: 'User interaction is not allowed.' })
    await expect(new FileDeviceSecrets(dir, macKeychainVault('acct', locked.run)).identityKey()).rejects.toMatchObject({ code: 'keystore_unavailable' })
    expect(locked.calls.map(c => c.args[0])).not.toContain('add-generic-password')

    // The item is gone (say, deleted by hand): still no new key, the file stays as it was.
    const emptied = fakeSecurity(null)
    await expect(new FileDeviceSecrets(dir, macKeychainVault('acct', emptied.run)).identityKey()).rejects.toMatchObject({ code: 'keystore_unavailable' })
    expect(emptied.calls.map(c => c.args[0])).toEqual(['find-generic-password'])
    expect(await readFile(path.join(dir, 'trust', 'secrets.json'), 'utf8')).toBe(sealed)

    // The original keychain still opens it.
    expect((await new FileDeviceSecrets(dir, macKeychainVault('acct', keychain.run)).identityKey()).publicKey).toEqual(first.publicKey)
  })

  it('asks the vault not to create when it opens an existing sealed file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aa-trust-'))
    const key = new Uint8Array(32).fill(3)
    const requests: (boolean | undefined)[] = []
    const vault: VaultKeyProvider = { kind: 'keychain', getOrCreate: async options => { requests.push(options?.create); return key } }
    await new FileDeviceSecrets(dir, vault).identityKey()
    await new FileDeviceSecrets(dir, vault).putDirectoryKey('dk_1', new Uint8Array(32))
    // First run: create allowed (the default). Second run: load and save of a sealed file never create.
    expect(requests).toEqual([undefined, false, false])
  })
})

describe('device secrets fallback to the 0600 file', () => {
  const noBus = () => fakeRunner(() => ({ code: 1, stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY' }))

  it('falls back on first run when the vault is unreachable, and says why', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aa-trust-'))
    const warnings: string[] = []
    const bus = noBus()
    const secrets = new FileDeviceSecrets(dir, secretServiceVault('acct', bus.run), { warn: message => warnings.push(message) })
    const first = await secrets.identityKey()
    expect(JSON.parse(await readFile(path.join(dir, 'trust', 'secrets.json'), 'utf8')).protection).toBe('none')
    expect(secrets.protection).toBe('none')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/secret-service vault is unavailable.*0600/u)
    expect(bus.calls.map(c => c.args[0])).toEqual(['lookup'])
    // Next start, still without a bus: the fallback file opens and the vault is not asked.
    const later = noBus()
    expect((await new FileDeviceSecrets(dir, secretServiceVault('acct', later.run)).identityKey()).publicKey).toEqual(first.publicKey)
    expect(later.calls).toEqual([])
  })

  it('stays on the fallback file once the vault becomes reachable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aa-trust-'))
    await new FileDeviceSecrets(dir, secretServiceVault('acct', noBus().run), { warn: () => undefined }).identityKey()
    const keychain = fakeSecurity(null)
    const secrets = new FileDeviceSecrets(dir, macKeychainVault('acct', keychain.run))
    await secrets.putDirectoryKey('dk_1', new Uint8Array(32).fill(1))
    expect(JSON.parse(await readFile(path.join(dir, 'trust', 'secrets.json'), 'utf8')).protection).toBe('none')
    expect(secrets.protection).toBe('none')
    expect(keychain.calls).toEqual([])
  })

  it('never falls back once the secrets are sealed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aa-trust-'))
    let stored: string | null = null
    const working = fakeRunner((_f, args, input) => {
      if (args[0] === 'lookup') return stored === null ? { code: 1 } : { stdout: stored }
      stored = input
      return { code: 0 }
    })
    await new FileDeviceSecrets(dir, secretServiceVault('acct', working.run)).identityKey()
    const file = path.join(dir, 'trust', 'secrets.json')
    const sealed = await readFile(file, 'utf8')
    expect(JSON.parse(sealed).protection).toBe('secret-service')
    const warnings: string[] = []
    const bus = noBus()
    await expect(new FileDeviceSecrets(dir, secretServiceVault('acct', bus.run), { warn: message => warnings.push(message) }).putDirectoryKey('dk_1', new Uint8Array(32)))
      .rejects.toMatchObject({ code: 'keystore_unavailable' })
    expect(await readFile(file, 'utf8')).toBe(sealed)
    expect(bus.calls.map(c => c.args[0])).toEqual(['lookup'])
    expect(warnings).toEqual([])
  })
})
