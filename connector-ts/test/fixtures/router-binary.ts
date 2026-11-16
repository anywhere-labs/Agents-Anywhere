import { accessSync, constants } from 'node:fs'

/**
 * The MeshCall Router built from 9334405 (vendor/meshcall has no Router binary and 0.4.0-dev
 * has no release to download): `MESHCALL_ROUTER_BINARY`, else the place A's harness uses.
 * Tests that need a real Router are skipped without one.
 */
export function routerBinary(): string | null {
  for (const path of [process.env.MESHCALL_ROUTER_BINARY, '/tmp/aa-mc/bin/meshcall-router']) {
    if (!path) continue
    try { accessSync(path, constants.X_OK); return path } catch { /* next */ }
  }
  return null
}
