import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileDeviceSecrets, FileTrustRepository, noVault, type VaultKeyProvider } from '../../src/keystore/index.js'
import { newDeviceTrust } from '../../src/domain/trust/index.js'

const fixedVault = (key = new Uint8Array(32).fill(7)): VaultKeyProvider => ({ kind: 'keychain', getOrCreate: async () => key })

describe('keystore', () => {
  it('identity key is stable across processes; file is 0600 and fully encrypted when a vault exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aa-trust-'))
    const first = await new FileDeviceSecrets(dir, fixedVault()).identityKey()
    await new FileDeviceSecrets(dir, fixedVault()).putDirectoryKey('dk_1', new Uint8Array(32).fill(1))
    const again = new FileDeviceSecrets(dir, fixedVault())
    expect((await again.identityKey()).publicKey).toEqual(first.publicKey)
    expect(await again.directoryKey('dk_1')).toEqual(new Uint8Array(32).fill(1))
    const file = path.join(dir, 'trust', 'secrets.json')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const raw = await readFile(file, 'utf8')
    expect(JSON.parse(raw).protection).toBe('keychain')
    expect(raw).not.toContain(Buffer.from(first.secretKey).toString('base64url'))
    await expect(new FileDeviceSecrets(dir, fixedVault(new Uint8Array(32).fill(8))).identityKey()).rejects.toThrow()
  })

  it('marks the vault as none when there is no system vault', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aa-trust-'))
    const secrets = new FileDeviceSecrets(dir, noVault())
    await secrets.identityKey()
    expect(JSON.parse(await readFile(path.join(dir, 'trust', 'secrets.json'), 'utf8')).protection).toBe('none')
    expect(secrets.protection).toBe('none')
  })

  it('reads and writes the trust list', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aa-trust-'))
    const repository = new FileTrustRepository(dir)
    expect(await repository.load()).toBeNull()
    const state = newDeviceTrust('dev', 'A'.repeat(43), 'dk_0')
    await repository.save(state)
    expect(await repository.load()).toEqual(state)
    await writeFile(path.join(dir, 'trust', 'trust.json'), JSON.stringify({ v: 9, state }))
    await expect(repository.load()).rejects.toThrow()
  })
})
