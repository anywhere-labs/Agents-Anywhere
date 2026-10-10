import { mkdir, realpath } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import { managerLockPorts } from '../../src/host/storage/files.js'

/**
 * Leases `path` exactly as plugins up to 2.0.3 did: only the first port of 49152-65535, closing
 * every connection at once. Undefined when this machine cannot bind that port, since such a
 * plugin could not run there either.
 */
export async function holdOlderPluginLease(path: string): Promise<(() => Promise<void>) | undefined> {
  await mkdir(dirname(path), { recursive: true })
  const directory = await realpath(dirname(path))
  const [port] = managerLockPorts(process.platform === 'win32' ? directory.toLowerCase() : directory, 49152)
  const server = createServer(socket => socket.destroy())
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve())
    })
  } catch (error) {
    if (['EACCES', 'EADDRINUSE'].includes(String((error as NodeJS.ErrnoException).code))) return undefined
    throw error
  }
  return () => new Promise<void>(resolve => server.close(() => resolve()))
}
