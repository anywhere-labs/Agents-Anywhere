// DeepSeek's standalone SDK runtime wheel contains a self-contained dsh executable, including Node.
// Release metadata and SHA-256 hashes: https://pypi.org/project/deepseek-harness-runtime-bin/0.2.2rc2/
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { dirname, join } from 'node:path'

import { unzip, type Unzipped } from 'fflate'

import type { Log } from '../../../application/ports/index.js'
import { RuntimeFailure } from '../../acp/errors.js'
import { atLeast, fileLock } from '../../supervisor/npm-runtime.js'
import type { DshLaunchPlan } from './launcher.js'

const VERSION = '0.2.2-rc.2'
const WHEEL = 'deepseek_harness_runtime_bin-0.2.2rc2-py3-none-'
const ARCHIVES = {
  'darwin-arm64': ['macosx_14_0_arm64', 'macos-arm64', '27/3c/3af58301dc7a71e5deb7807fa7f084c82609feca777ee0c3696ce80f27f1', 91_559_131, '76ac8fe84e6999e14a2229e20cbcaa819dc22b5bfaa40abb0fe810db8a31abc7'],
  'darwin-x64': ['macosx_14_0_x86_64', 'macos-x64', '1d/58/0b17819770412a9ef3ba2ee473d516d2819ff7bd6498a310b45740a82516', 94_953_513, '3abb396390e34fc699119060302531d71ec0df6a79adf070572d77715ba1f395'],
  'linux-arm64': ['manylinux_2_28_aarch64', 'linux-arm64', '2e/37/18bd653d61f244d77ded9122efd924d45e03c5c74a035af26adb9285', 99_239_965, 'dc8f6e2c463c9c174b8fbafa394ada62351ff16b9febde4b90dca6b57f1b4e84'],
  'linux-x64': ['manylinux_2_28_x86_64', 'linux-x64', 'ba/77/9ea8e90daa84f9f1ea9982521e9e1f6d99223857efc6f9cf739b4b85', 97_364_370, '3c8f15a7a92b12857032995ec5dbcc105f192c36218e9b6bb2c5b54b4ee7db17'],
  'win32-x64': ['win_amd64', 'win-x64', '4e/87/cc1080f32f3835637d93d265ff94d2b24a1ec6b96780894a7e7eeb0a0b5a', 86_959_936, 'a791af95a97be205a73354c6819e95b5fe2ff40a57ef8a78d53c188ee33e9aea'],
} as const
const WHEEL_RUNTIME = 'deepseek_harness_runtime/runtime/'
const DOWNLOAD_TIMEOUT_MS = 210_000

function compatiblePlatform(): boolean {
  if (process.platform === 'darwin') return Number(release().split('.')[0]) >= 23
  if (process.platform !== 'linux') return true
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
  const glibc = report?.header?.glibcVersionRuntime?.split('.').map(Number)
  return glibc !== undefined && atLeast(glibc, [2, 28])
}

async function download(url: string, size: number, sha256: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok || response.body === null) throw new Error(`PyPI returned HTTP ${response.status}`)
  const bytes = new Uint8Array(size)
  let offset = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (offset + value.length > bytes.length) throw new Error('Unexpected DSH archive size')
      bytes.set(value, offset)
      offset += value.length
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  if (offset !== size || createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error('DSH archive failed size or SHA-256 verification')
  }
  return bytes
}

/** Only extract the known runtime payload, never wheel scripts or arbitrary archive paths. */
function extract(bytes: Uint8Array, paths: readonly string[]): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    unzip(bytes, { filter: file => paths.includes(file.name.slice(WHEEL_RUNTIME.length)) && file.name.startsWith(WHEEL_RUNTIME) },
      (error, files) => error ? reject(error) : resolve(files))
  })
}

export interface ManagedDshRuntime {
  cached(): Promise<DshLaunchPlan | undefined>
  install(): Promise<DshLaunchPlan>
}

export function managedDshRuntime(root: string, log: Log): ManagedDshRuntime | undefined {
  const target = `${process.platform}-${process.arch}`
  const archive = ARCHIVES[target as keyof typeof ARCHIVES]
  if (!archive || !compatiblePlatform()) return undefined
  const [tag, name, location, size, digest] = archive
  const binary = `deepseek-harness-sdk-runtime-${name}`
  const extension = process.platform === 'win32' ? '.exe' : ''
  const paths = [binary + extension, `${binary}-rg${extension}`, `${name}/downloads.json`]
  if (process.platform === 'darwin') paths.push(`${binary}-spawn-helper`)
  const directory = join(root, `${VERSION}-${target}`)
  const command = join(directory, binary + extension)
  const plan: DshLaunchPlan = { command, args: ['--profile', 'acp'], source: 'managed', version: VERSION }
  const cached = async (): Promise<DshLaunchPlan | undefined> => {
    const present = await Promise.all(paths.map(path => stat(join(directory, path)).catch(() => undefined)))
    return present.every(file => file?.isFile() && file.size > 0) ? plan : undefined
  }

  async function install(): Promise<DshLaunchPlan> {
    const existing = await cached()
    if (existing) return existing
    let unlock: (() => Promise<void>) | undefined
    let staging: string | undefined
    try {
      unlock = await fileLock(`${directory}.lock`, { timeoutMs: DOWNLOAD_TIMEOUT_MS + 15_000 })
      const installed = await cached()
      if (installed) return installed
      log('info', `Preparing DSH ${VERSION} (${target}) from PyPI`)
      const bytes = await download(`https://files.pythonhosted.org/packages/${location}/${WHEEL}${tag}.whl`, size, digest)
      const files = await extract(bytes, paths)
      staging = await mkdtemp(join(root, '.dsh-install-'))
      for (const path of paths) {
        const data = files[WHEEL_RUNTIME + path]
        if (!data?.length) throw new Error(`DSH archive is missing ${path}`)
        const output = join(staging, path)
        await mkdir(dirname(output), { recursive: true, mode: 0o700 })
        await writeFile(output, data, { mode: 0o600 })
        if (!path.endsWith('.json')) await chmod(output, 0o700)
      }
      await rm(directory, { recursive: true, force: true })
      await rename(staging, directory)
      log('info', `DSH ${VERSION} is ready (${target})`)
      return plan
    } catch (error) {
      log('warn', `DSH installation failed: ${error instanceof Error ? error.message : String(error)}`)
      const code = error instanceof RuntimeFailure && error.error.code === 'agent_install_busy' ? error.error.code : 'agent_install_failed'
      throw new RuntimeFailure({ code, message: 'Unable to prepare DSH on the work device.', retryable: true, details: { definite: true } })
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      await unlock?.()
    }
  }
  return { cached, install }
}
