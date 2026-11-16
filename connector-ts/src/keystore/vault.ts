// 系统钥匙串里只放一把「保险库密钥」，设备的其余秘密用它加密后存在数据目录（file-secrets.ts）。
// macOS：Keychain（security 命令，登录钥匙串，不同步 iCloud）；Windows：DPAPI（当前用户）；
// Linux：Secret Service（secret-tool）。都不可用时退回 0600 文件，并如实报告。

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface VaultKeyProvider {
  /** `keychain` | `dpapi` | `secret-service` | `none` (file permissions only). */
  readonly kind: string
  /** The 32-byte vault key, created on first use; null when the platform offers no protected store. */
  getOrCreate(): Promise<Uint8Array | null>
}

const SERVICE = 'Agents Anywhere device secrets'
const KEY_BYTES = 32

export function macKeychainVault(account: string): VaultKeyProvider {
  return {
    kind: 'keychain',
    async getOrCreate() {
      try {
        const { stdout } = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'])
        const key = Buffer.from(stdout.trim(), 'base64')
        if (key.length === KEY_BYTES) return new Uint8Array(key)
      } catch {
        // Not found: create below.
      }
      const key = randomBytes(KEY_BYTES)
      // -U updates an existing item; the item stays in the login keychain and is not synchronised.
      await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', key.toString('base64')])
      return new Uint8Array(key)
    },
  }
}

/** DPAPI (CurrentUser) through PowerShell: the vault key is stored DPAPI-protected next to the secrets. */
export function windowsDpapiVault(protectedPath: string): VaultKeyProvider {
  const ps = (script: string) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  const load = 'Add-Type -AssemblyName System.Security;'
  return {
    kind: 'dpapi',
    async getOrCreate() {
      try {
        const sealed = (await readFile(protectedPath, 'utf8')).trim()
        const { stdout } = await ps(
          `${load}[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${sealed}'),$null,'CurrentUser'))`,
        )
        const key = Buffer.from(stdout.trim(), 'base64')
        if (key.length === KEY_BYTES) return new Uint8Array(key)
      } catch {
        // Missing or unreadable: create below.
      }
      const key = randomBytes(KEY_BYTES)
      const { stdout } = await ps(
        `${load}[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String('${key.toString('base64')}'),$null,'CurrentUser'))`,
      )
      await writeFile(protectedPath, stdout.trim(), { mode: 0o600 })
      return new Uint8Array(key)
    },
  }
}

export function secretServiceVault(account: string): VaultKeyProvider {
  const attributes = ['service', SERVICE, 'account', account]
  return {
    kind: 'secret-service',
    async getOrCreate() {
      try {
        const { stdout } = await run('secret-tool', ['lookup', ...attributes])
        const key = Buffer.from(stdout.trim(), 'base64')
        if (key.length === KEY_BYTES) return new Uint8Array(key)
      } catch {
        // Not found or no Secret Service: try to create.
      }
      const key = randomBytes(KEY_BYTES)
      try {
        const child = execFile('secret-tool', ['store', '--label', SERVICE, ...attributes])
        child.stdin?.end(key.toString('base64'))
        await new Promise<void>((resolve, reject) => child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`secret-tool ${code}`)))))
        return new Uint8Array(key)
      } catch {
        return null
      }
    },
  }
}

export function noVault(): VaultKeyProvider {
  return { kind: 'none', getOrCreate: async () => null }
}

/** The platform's protected store, keyed by the OS user's Connector data directory. */
export function platformVault(account: string, dataDir: string): VaultKeyProvider {
  switch (process.platform) {
    case 'darwin':
      return macKeychainVault(account)
    case 'win32':
      return windowsDpapiVault(`${dataDir}/trust/vault.dpapi`)
    case 'linux':
      return secretServiceVault(account)
    default:
      return noVault()
  }
}
