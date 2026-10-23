// Guards against @deepseek-ai/schemastery being installed as multiple copies.
//
// The plugin pins schemastery exactly in devDependencies and mirrors the same
// exact version under "resolutions": the transitive dependency
// @deepseek-ai/dsh-session-title declares schemastery as a range (~3.18.4),
// and the repo intentionally commits no lockfile, so every fresh install
// resolves that range against the newest matching release. When the release
// drifts away from the devDependency pin, Yarn nests a second copy and the
// typecheck dies with an opaque TS6200 conflict between the two
// lib/types/index.d.ts files (issue #374).
//
// Note that resolutions does not override the root package's own
// devDependencies, so the pin and the mirror must be bumped together. This
// check fails early with an actionable message when they drift apart, and
// after install if a nested copy exists anyway.
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
  devDependencies: Record<string, string>
  resolutions?: Record<string, string>
}

const packageName = '@deepseek-ai/schemastery'
const devPin = manifest.devDependencies[packageName]
const resolutionPin = manifest.resolutions?.[packageName]
assert.ok(devPin, `package.json devDependencies must pin ${packageName} to an exact version`)
assert.ok(resolutionPin, `package.json resolutions must mirror the ${packageName} pin, or transitive ranges drift into a nested second copy (issue #374)`)
assert.equal(
  resolutionPin,
  devPin,
  `resolutions "${packageName}" (${resolutionPin}) must equal the devDependencies pin (${devPin}); `
  + 'resolutions does not override the root devDependency, so bump both together',
)

const scope = 'node_modules/@deepseek-ai/'
const nestedCopies: string[] = []
if (existsSync(fileURLToPath(new URL(scope, root)))) {
  for (const entry of readdirSync(fileURLToPath(new URL(scope, root)))) {
    const nested = `node_modules/@deepseek-ai/${entry}/node_modules/${packageName}`
    if (existsSync(fileURLToPath(new URL(nested, root)))) nestedCopies.push(nested)
  }
}
assert.equal(
  nestedCopies.length,
  0,
  `Nested duplicate ${packageName} copies detected:\n${nestedCopies.map(copy => `- ${copy}`).join('\n')}\n`
  + 'Fresh-install the dependencies and make sure the devDependencies pin and resolutions stay in sync.',
)

console.log(`依赖去重检查通过：${packageName} 以单副本 ${devPin} 安装，devDependencies pin 与 resolutions 一致。`)
