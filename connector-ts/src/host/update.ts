// ported from effi-crew cloud/agentd/src/crew/update.ts @30f8334 (signed updates)
//
// Signed automatic updates for the CLI and the DSH host, which run under the launcher
// (connector-ts/installer/launcher.{sh,ps1}) from <app>/current → <app>/versions/<version>. The Connector asks for the release meant for this device, checks the manifest's
// Ed25519 signature against the keys built in, downloads the package for its platform, checks size and sha256,
// unpacks it next to the running version, writes <app>/pending and exits with 75 once no turn is running. The
// launcher switches `current`; a new version that keeps failing within two minutes is rolled back. A Connector run
// any other way (Desktop bundles its own, a developer checkout) does not update itself.
import { execFile } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const CHECK_EVERY_MS = 30 * 60_000
const JITTER_MS = 5 * 60_000
const FIRST_CHECK_MS = 60_000
/** The exit code that tells the launcher an update is staged. */
export const EXIT_UPDATE = 75

export interface ReleaseFile {
  readonly name: string
  readonly sha256: string
  readonly size: number
}

export interface ReleaseManifest {
  readonly version: string
  readonly released_at?: string
  readonly notes?: string
  readonly files: Readonly<Record<string, ReleaseFile>>
  readonly signature: string
}

/** JSON with sorted keys: the bytes the signature covers. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Whether the manifest is signed by one of `keys` (base64 raw Ed25519 public keys). */
export function verifyManifest(manifest: ReleaseManifest, keys: readonly string[]): boolean {
  if (typeof manifest.signature !== 'string' || manifest.signature === '') return false
  const { signature, ...rest } = manifest
  const data = Buffer.from(canonical(rest))
  const sig = Buffer.from(signature, 'base64')
  for (const key of keys) {
    const raw = Buffer.from(key, 'base64')
    if (raw.length !== 32) continue
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])
    try {
      if (verify(null, data, createPublicKey({ key: der, format: 'der', type: 'spki' }), sig)) return true
    } catch {
      // A malformed key or signature: not this one.
    }
  }
  return false
}

/** 3.10.0 > 3.9.3; pre-release parts compare as strings. */
export function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/u)
  const pb = b.split(/[.-]/u)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0'
    const y = pb[i] ?? '0'
    const nx = Number(x)
    const ny = Number(y)
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx > ny
    } else if (x !== y) return x > y
  }
  return false
}

export function releaseTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`
}

export interface UpdaterDeps {
  readonly version: string
  /** The launcher's app directory (`AA_CONNECTOR_APP_ROOT`); undefined: not installed that way → no updates. */
  readonly appRoot: string | undefined
  /** Release keys built into this Connector. */
  readonly keys: readonly string[]
  /** The release meant for this device and target (the Server decides the rollout). */
  readonly fetchRelease: (version: string, target: string) => Promise<ReleaseManifest | null>
  /** The bytes of a release file. */
  readonly download: (file: ReleaseFile) => Promise<Buffer>
  /** Nothing running that an update would cut off (no turn, no Shell task). */
  readonly idle: () => boolean
  /** Stop for the update (exit code 75). */
  readonly restart: () => void
  readonly log: (level: 'info' | 'warn' | 'error', message: string) => void
  readonly target?: string
  /** Unpacks an archive into a directory (default: `tar -xf`, which also reads .zip on Windows 10+). */
  readonly unpack?: (archive: string, into: string) => Promise<void>
}

export class Updater {
  private timer: NodeJS.Timeout | undefined
  private busy = false
  private staged: string | undefined

  public constructor(private readonly deps: UpdaterDeps) {}

  public start(): void {
    if (this.deps.appRoot === undefined || this.deps.keys.length === 0) return
    this.schedule(FIRST_CHECK_MS)
  }

  public stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => void this.tick(), ms)
    this.timer.unref()
  }

  private async tick(): Promise<void> {
    try {
      if (this.staged === undefined) await this.check()
      if (this.staged !== undefined) this.restartWhenIdle()
    } catch (error) {
      this.deps.log('warn', `update check failed: ${(error as Error).message}`)
    }
    this.schedule(this.staged !== undefined ? 60_000 : CHECK_EVERY_MS + Math.round((Math.random() - 0.5) * JITTER_MS))
  }

  /** Asks, verifies, downloads and unpacks; returns the staged version, or undefined. */
  public async check(): Promise<string | undefined> {
    if (this.busy || this.deps.appRoot === undefined) return undefined
    this.busy = true
    try {
      const target = this.deps.target ?? releaseTarget()
      const manifest = await this.deps.fetchRelease(this.deps.version, target)
      if (manifest === null || !newer(manifest.version, this.deps.version)) return undefined
      if (!verifyManifest(manifest, this.deps.keys)) {
        this.deps.log('error', `release ${manifest.version} has no valid signature: not installing it`)
        return undefined
      }
      const file = manifest.files[target]
      if (file === undefined) {
        this.deps.log('warn', `release ${manifest.version} has nothing for ${target}`)
        return undefined
      }
      const dir = join(this.deps.appRoot, 'versions', manifest.version)
      if (!existsSync(join(dir, 'VERSION'))) await this.install(manifest.version, file, dir)
      await writeFile(join(this.deps.appRoot, 'pending'), `${manifest.version}\n`)
      this.staged = manifest.version
      this.deps.log('info', `Connector ${manifest.version} is ready; restarting into it when nothing is running`)
      return manifest.version
    } finally {
      this.busy = false
    }
  }

  private async install(version: string, file: ReleaseFile, dir: string): Promise<void> {
    const data = await this.deps.download(file)
    const sum = createHash('sha256').update(data).digest('hex')
    if (sum !== file.sha256 || data.length !== file.size) throw new Error(`${file.name}: checksum mismatch, not installed`)
    const root = this.deps.appRoot!
    const tmp = join(root, `.download-${version}`)
    await rm(tmp, { recursive: true, force: true })
    await mkdir(tmp, { recursive: true })
    const archive = join(tmp, file.name)
    await writeFile(archive, data)
    await (this.deps.unpack ?? (async (a, into) => {
      await run('tar', ['-xf', a, '-C', into])
    }))(archive, tmp)
    await rm(archive)
    const unpacked = join(tmp, `anywhere-cli-${version}`)
    if (!existsSync(join(unpacked, 'VERSION'))) throw new Error('the package has no VERSION file')
    await rm(dir, { recursive: true, force: true })
    await mkdir(join(root, 'versions'), { recursive: true })
    await rename(unpacked, dir)
    await rm(tmp, { recursive: true, force: true })
  }

  private restartWhenIdle(): void {
    if (!this.deps.idle()) return
    this.deps.log('info', `restarting into Connector ${this.staged ?? ''}`)
    this.deps.restart()
  }
}
