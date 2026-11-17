// 系统钥匙串里只放一把「保险库密钥」，设备的其余秘密用它加密后存在数据目录（file-secrets.ts）。
// macOS：Keychain（security 命令，登录钥匙串，不同步 iCloud）；Windows：DPAPI（当前用户）；
// Linux：Secret Service（secret-tool）。平台没有这些工具时退回 0600 文件，并如实报告。
//
// 两条规则保护已有的密钥：
// - 只有保险库明确回答「没有这一项」时才生成新密钥。钥匙串锁着、没有图形界面、DBus 不可用、读出的内容不对，
//   一律报 `keystore_unavailable`，不生成、不覆盖：覆盖会让 secrets.json 永久解不开，设备身份和授权全部丢失。
// - 密钥只经子进程的 stdin / stdout 传递，从不出现在命令行参数里（同机其他用户能用 `ps` 看到 argv）。

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface VaultKeyProvider {
  /** `keychain` | `dpapi` | `secret-service` | `none` (file permissions only). */
  readonly kind: string
  /**
   * The 32-byte vault key. Created only when the store answers that it has none and `create` is not false (the
   * default); with `create: false` that answer is null. Null as well when the platform offers no protected store.
   * Any other failure throws a `KeystoreError` (`keystore_unavailable`) and leaves the store as it was.
   */
  getOrCreate(options?: { readonly create?: boolean }): Promise<Uint8Array | null>
}

/** A protected store that could not be read or written; the key it may hold is left alone. */
export class KeystoreError extends Error {
  public constructor(
    public readonly code: 'keystore_unavailable',
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'KeystoreError'
  }
}

export interface CommandOutcome {
  /** Exit code; null when the process was killed (timeout). */
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Runs one command. `input` is written to stdin and the pipe closed. `detached` starts it in a new session (POSIX
 * `setsid`) so it has no controlling terminal: `security` prompts on `/dev/tty` when it has one and reads stdin only
 * when it does not. Rejects (`ENOENT`) when the program does not exist.
 */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: { readonly input?: string; readonly detached?: boolean },
) => Promise<CommandOutcome>

/** A keychain access prompt can wait on the person at the computer; give it time, but not forever. */
const COMMAND_TIMEOUT_MS = 120_000

export const runCommand: CommandRunner = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ['pipe', 'pipe', 'pipe'], detached: options.detached ?? false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), COMMAND_TIMEOUT_MS)
    timer.unref()
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.input ?? '')
  })

const SERVICE = 'Agents Anywhere device secrets'
const KEY_BYTES = 32

const unavailable = (kind: string, reason: string, outcome?: CommandOutcome): KeystoreError =>
  new KeystoreError('keystore_unavailable', `the ${kind} vault is unavailable (${reason})${outcome?.stderr.trim() ? `: ${outcome.stderr.trim()}` : ''}`, {
    kind,
    reason,
    ...(outcome !== undefined ? { exitCode: outcome.code } : {}),
  })

const isMissingProgram = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'

/** A stored key: base64 of exactly 32 bytes, or a `malformed` failure (never replaced by a new one). */
function decodeKey(kind: string, text: string): Uint8Array {
  const trimmed = text.trim()
  const key = Buffer.from(trimmed, 'base64')
  if (key.length !== KEY_BYTES || key.toString('base64') !== trimmed) throw unavailable(kind, 'malformed')
  return new Uint8Array(key)
}

/** `security` exit codes: errSecItemNotFound (-25300) and errSecDuplicateItem (-25299) as the tool reports them. */
const MAC_NOT_FOUND = 44
const MAC_DUPLICATE = 45

export function macKeychainVault(account: string, run: CommandRunner = runCommand): VaultKeyProvider {
  const kind = 'keychain'
  const find = async (): Promise<Uint8Array | null> => {
    const outcome = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], { detached: true })
    if (outcome.code === 0) return decodeKey(kind, outcome.stdout)
    if (outcome.code === MAC_NOT_FOUND) return null
    throw unavailable(kind, 'read_failed', outcome)
  }
  return {
    kind,
    async getOrCreate(options) {
      let existing: Uint8Array | null
      try {
        existing = await find()
      } catch (error) {
        if (isMissingProgram(error)) return null
        throw error
      }
      if (existing !== null || options?.create === false) return existing
      const key = randomBytes(KEY_BYTES).toString('base64')
      // `-w` last with no value: `security` asks for the password (and again to confirm) and, without a controlling
      // terminal, reads both answers from stdin. No `-U`: an item that appeared meanwhile is never overwritten.
      // The item stays in the login keychain and is not synchronised.
      const added = await run('security', ['add-generic-password', '-s', SERVICE, '-a', account, '-w'], { input: `${key}\n${key}\n`, detached: true })
      if (added.code !== 0 && added.code !== MAC_DUPLICATE) throw unavailable(kind, 'write_failed', added)
      // Read back: a duplicate means another process created it first, and its key is the one to use.
      const stored = await find()
      if (stored === null) throw unavailable(kind, 'write_failed', added)
      return stored
    },
  }
}

/**
 * DPAPI (CurrentUser) through PowerShell: the vault key is stored DPAPI-protected next to the secrets. The sealed
 * blob goes in and the key comes out over stdin / stdout; the scripts on the command line carry no data.
 */
export function windowsDpapiVault(protectedPath: string, run: CommandRunner = runCommand): VaultKeyProvider {
  const kind = 'dpapi'
  const ps = (script: string, input: string) =>
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Security;${script}`], { input })
  const transform = (method: 'Protect' | 'Unprotect') =>
    `$in=[Console]::In.ReadToEnd().Trim();[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${method}([Convert]::FromBase64String($in),$null,'CurrentUser'))`
  const getOrCreate = async (options?: { readonly create?: boolean }): Promise<Uint8Array | null> => {
    let sealed: string | null
    try {
      sealed = (await readFile(protectedPath, 'utf8')).trim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unavailable(kind, 'read_failed')
      sealed = null
    }
    try {
      if (sealed !== null) {
        const outcome = await ps(transform('Unprotect'), sealed)
        if (outcome.code !== 0) throw unavailable(kind, 'read_failed', outcome)
        return decodeKey(kind, outcome.stdout)
      }
      if (options?.create === false) return null
      const key = randomBytes(KEY_BYTES)
      const outcome = await ps(transform('Protect'), key.toString('base64'))
      if (outcome.code !== 0 || outcome.stdout.trim() === '') throw unavailable(kind, 'write_failed', outcome)
      // `wx`: a file another process wrote meanwhile is kept; its key is the one to use.
      try {
        await mkdir(dirname(protectedPath), { recursive: true, mode: 0o700 })
        await writeFile(protectedPath, outcome.stdout.trim(), { mode: 0o600, flag: 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return await getOrCreate({ create: false })
        throw unavailable(kind, 'write_failed')
      }
      return new Uint8Array(key)
    } catch (error) {
      if (isMissingProgram(error)) return null
      throw error
    }
  }
  return { kind, getOrCreate }
}

/**
 * Secret Service through `secret-tool`. `lookup` of an absent item exits 1 with no output; anything on stderr (no
 * session bus, a locked collection that cannot be unlocked) is a failure, not an absence.
 */
export function secretServiceVault(account: string, run: CommandRunner = runCommand): VaultKeyProvider {
  const kind = 'secret-service'
  const attributes = ['service', SERVICE, 'account', account]
  const lookup = async (): Promise<Uint8Array | null> => {
    const outcome = await run('secret-tool', ['lookup', ...attributes])
    if (outcome.stderr.trim() === '') {
      if (outcome.code === 0 && outcome.stdout.trim() !== '') return decodeKey(kind, outcome.stdout)
      if ((outcome.code === 0 || outcome.code === 1) && outcome.stdout.trim() === '') return null
    }
    throw unavailable(kind, 'read_failed', outcome)
  }
  return {
    kind,
    async getOrCreate(options) {
      try {
        const existing = await lookup()
        if (existing !== null || options?.create === false) return existing
        const key = randomBytes(KEY_BYTES).toString('base64')
        // `store` reads the secret from stdin when stdin is not a terminal.
        const stored = await run('secret-tool', ['store', '--label', SERVICE, ...attributes], { input: key })
        if (stored.code !== 0) throw unavailable(kind, 'write_failed', stored)
        const again = await lookup()
        if (again === null) throw unavailable(kind, 'write_failed', stored)
        return again
      } catch (error) {
        if (isMissingProgram(error)) return null
        throw error
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
