// The device-side dependencies of the client API (`DeviceTunnelApi`) that the composition root assembles from the
// Runtime registry, the device link and the workspace service.
import type { RuntimeRegistry } from '../application/index.js'
import { uploadPreparedDownload, type WorkspaceServiceDeps } from '../link/index.js'
import type { RuntimeCatalogs } from '../sync/index.js'

/**
 * `connectors/{id}/runtimes/{r}/catalogs/*`: an instance this device has answers the catalogs of its started handle;
 * one that is not running (or whose Agent fails to answer) has no catalogs yet. Reading never starts an Agent.
 */
export function instanceCatalogs(registry: Pick<RuntimeRegistry, 'spec' | 'started'>): RuntimeCatalogs {
  return {
    catalogs: async runtimeId => {
      const spec = registry.spec(runtimeId)
      if (spec === null) return null
      const handle = await registry.started(runtimeId)
      const catalogs = handle === null || handle === undefined ? null : ((await handle.catalogs().catch(() => null)) as Record<string, unknown> | null)
      return { runtimeType: spec.runtimeType, catalogs }
    },
  }
}

/**
 * `POST fs/read`: the prepared download goes to the Server's transfer relay through `fs.uploadPreparedDownload` (the
 * file is checked against the roots, the bytes are sent in the background).
 */
export function preparedDownloadUpload(workspace: WorkspaceServiceDeps): (params: Record<string, unknown>) => Promise<unknown> {
  return async params => uploadPreparedDownload(workspace, params)
}
