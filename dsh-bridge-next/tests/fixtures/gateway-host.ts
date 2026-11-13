import type { Context } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { interactionPeer } from '../../src/host/dsh-runtime/interaction-stream.js'

/**
 * 0.2.1 Gateway and SessionController inject the official RemoteAccess policy
 * service. Mount it before them; a runtime without the package (0.2.0, or an
 * older DSH_INTERACTION_RUNTIME_ROOT installation) has no such dependency.
 */
export async function mountRemoteAccess(ctx: Context): Promise<void> {
  if (ctx.get('remoteAccess')) return
  const requireRuntime = createRequire(process.env.DSH_INTERACTION_RUNTIME_ROOT
    ? resolve(process.env.DSH_INTERACTION_RUNTIME_ROOT, 'package.json') : import.meta.url)
  let remoteAccess: string | undefined
  try { remoteAccess = requireRuntime.resolve('@deepseek-ai/dsh-api-remote-access') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error }
  if (remoteAccess) await ctx.plugin((await import(pathToFileURL(remoteAccess).href)).default).await()
}

/**
 * The local owner Peer an in-process Gateway call speaks for; 0.2.1 rejects
 * calls without one. Uses the composed Connection when present.
 */
export function ownerPeer(ctx: Context): PeerScope {
  const connection = ctx.get('connection') ?? new HostConnectionService(ctx, [], {} as ConstructorParameters<typeof HostConnectionService>[2])
  return interactionPeer(connection)
}
