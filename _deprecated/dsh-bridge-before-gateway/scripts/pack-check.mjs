import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-bridge-pack-'))
const archivePath = join(temporaryRoot, 'dsh-bridge.tgz')
const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack'

try {
  await rm(join(packageRoot, 'lib'), { recursive: true, force: true })
  await run(corepack, ['yarn', 'pack', '--out', archivePath], { cwd: packageRoot })

  const archive = await run('tar', ['-tzf', archivePath])
  const entries = archive.stdout
    .split('\n')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0 && !entry.endsWith('/'))
  validateArchive(entries)

  const extractedRoot = join(temporaryRoot, 'extracted')
  await mkdir(extractedRoot)
  await run('tar', ['-xzf', archivePath, '-C', extractedRoot])
  const packedManifest = JSON.parse(await readFile(join(extractedRoot, 'package', 'package.json'), 'utf8'))
  assert.equal(packedManifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(packedManifest.packageManager, 'yarn@4.6.0')

  const consumerRoot = join(temporaryRoot, 'consumer')
  await mkdir(consumerRoot)
  const hostTestDependencies = Object.fromEntries(Object.entries(manifest.devDependencies)
    .filter(([name]) => name === '@deepseek-ai/cordis'
      || name.startsWith('@deepseek-ai/cordis-plugin-')
      || name === '@deepseek-ai/dsh'
      || name.startsWith('@deepseek-ai/dsh-')))
  const dependencies = {
    ...hostTestDependencies,
    ...manifest.peerDependencies,
    [manifest.name]: `file:${archivePath}`,
  }
  await writeFile(join(consumerRoot, 'package.json'), `${JSON.stringify({
    name: 'dsh-bridge-pack-consumer',
    private: true,
    type: 'module',
    packageManager: 'yarn@4.6.0',
    dependencies,
  }, null, 2)}\n`)
  await writeFile(join(consumerRoot, '.yarnrc.yml'), 'nodeLinker: node-modules\nenableImmutableInstalls: false\n')
  await run(corepack, ['yarn', 'install'], { cwd: consumerRoot })
  await run(corepack, ['yarn', 'install', '--immutable'], { cwd: consumerRoot })

  await run(process.execPath, ['--input-type=module', '--eval', [
    `const bridge = await import(${JSON.stringify(manifest.name)})`,
    "if (bridge.RUNTIME_ID !== 'dsh') throw new Error('unexpected runtime identity')",
    "if (bridge.MAX_FRAME_BYTES !== 8 * 1024 * 1024) throw new Error('unexpected frame limit')",
  ].join('\n')], { cwd: consumerRoot })

  await verifyDumpConfig(consumerRoot)
  process.stdout.write(`pack-check: ${entries.length} files; install, import, and dump-config passed\n`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

function validateArchive(entries) {
  assert.equal(new Set(entries).size, entries.length, 'tarball contains duplicate paths')
  const required = [
    'package/LICENSE',
    'package/NOTICE',
    'package/README.md',
    'package/cordis.patch.yml',
    'package/lib/index.js',
    'package/lib/types/index.d.ts',
    'package/package.json',
  ]
  for (const path of required) assert(entries.includes(path), `tarball is missing ${path}`)
  for (const path of entries) {
    const isStatic = required.includes(path)
    const isJavaScript = /^package\/lib\/.+\.js$/u.test(path)
    const isDeclaration = /^package\/lib\/types\/.+\.d\.ts$/u.test(path)
    assert(isStatic || isJavaScript || isDeclaration, `unexpected tarball entry: ${path}`)
    assert(!path.endsWith('.map'), `source map must not be published: ${path}`)
  }
  assert(entries.some(path => /^package\/lib\/.+\.js$/u.test(path)), 'tarball contains no JavaScript output')
  assert(entries.some(path => /^package\/lib\/types\/.+\.d\.ts$/u.test(path)), 'tarball contains no declarations')
}

async function verifyDumpConfig(consumerRoot) {
  const dshHome = join(consumerRoot, '.dsh')
  await mkdir(dshHome, { mode: 0o700 })
  const dshBin = join(consumerRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const env = { ...process.env, DSH_HOME: dshHome }
  await run(process.execPath, [dshBin, '--profile', 'headless', '--dump-default-config'], {
    cwd: consumerRoot,
    env,
  })

  const profileManifestPath = join(dshHome, 'profiles', 'headless', 'package.json')
  const profileManifest = JSON.parse(await readFile(profileManifestPath, 'utf8'))
  const bundles = profileManifest.dsh?.profile?.bundles
  assert(Array.isArray(bundles), 'DSH did not initialize a profile bundle list')
  if (!bundles.includes(manifest.name)) bundles.push(manifest.name)
  await writeFile(profileManifestPath, `${JSON.stringify(profileManifest, null, 2)}\n`)

  const dump = await run(process.execPath, [dshBin, '--profile', 'headless', '--dump-config'], {
    cwd: consumerRoot,
    env,
  })
  assert.match(dump.stdout, /agents-anywhere-bridge/u)
  assert.match(dump.stdout, /@agents-anywhere\/dsh-bridge/u)
}

async function run(file, args, options = {}) {
  try {
    return await execFileAsync(file, args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    })
  } catch (error) {
    if (typeof error.stdout === 'string') process.stderr.write(error.stdout)
    if (typeof error.stderr === 'string') process.stderr.write(error.stderr)
    throw error
  }
}
