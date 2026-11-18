import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

// import.meta.url points to the bundled entry at runtime, so these files go beside it.
/** @type {ReadonlyArray<readonly [string, string]>} */
const RUNTIME_FILES = [
  ['src/runtime/profiles/pi/assets/sdk-bridge.mjs', 'assets/sdk-bridge.mjs'],
  ['src/runtime/profiles/pi/assets/permissions.mjs', 'assets/permissions.mjs'],
  ['src/runtime/supervisor/assets/electron-node.mjs', 'assets/electron-node.mjs'],
  ['src/runtime/profiles/pi/dependencies.json', 'dependencies.json'],
]

/**
 * @param {string} connectorRoot
 * @param {string} outputDir
 */
export function copyBundleRuntimeFiles(connectorRoot, outputDir) {
  for (const [source, relativeDestination] of RUNTIME_FILES) {
    const destination = join(outputDir, relativeDestination)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(connectorRoot, source), destination)
  }
}
