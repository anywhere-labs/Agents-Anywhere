// Native MeshCall client driven by the Server integration suite over JSON lines.
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { generateE2EKey, Mesh, MeshCallError, Router, type RpcStream } from 'meshcall'

const [serverUrl, accessToken] = process.argv.slice(2)
if (!serverUrl || !accessToken) throw new Error('serverUrl and accessToken are required')
const write = (message: Record<string, unknown>): void => { process.stdout.write(JSON.stringify(message) + '\n') }
const content = 'aa.device.v1.Content'
const identity = await generateE2EKey()
const secret = randomBytes(32).toString('base64url')
let deviceId = ''
let devicePub = ''
let clientId = ''
let mesh: Mesh | undefined
let nextSubscription = 0
const streams = new Map<string, RpcStream<Record<string, unknown>>>()
const options = () => ({ instance: deviceId, metadata: { 'aa-content-client': clientId, 'aa-content-credential': secret } })

interface Grant {
  router_url: string
  credential: string
  instance_id: string
  e2e_key: string
}

async function open(pin: string): Promise<Mesh> {
  const response = await fetch(new URL('/api/v3/mobile/control-tunnel', serverUrl), {
    method: 'POST', headers: { authorization: 'Bearer ' + accessToken },
  })
  if (!response.ok) throw new Error('control-tunnel: HTTP ' + response.status)
  const bootstrap = await response.json() as Grant
  const management = new Mesh(new Router(bootstrap.router_url), { tunnel: bootstrap.credential, e2eKey: bootstrap.e2e_key })
  try {
    const grant = await management.unary<{ deviceId: string }, Grant>(
      'aa.server.v1.MobileControl', 'issue_content_tunnel', { deviceId }, { instance: bootstrap.instance_id },
    )
    if (grant.instance_id !== deviceId || grant.e2e_key !== pin)
      throw new MeshCallError('device_pin_mismatch', 'Unexpected Connector identity')
    return new Mesh(new Router(grant.router_url), { tunnel: grant.credential, e2eKey: pin })
  } finally {
    await management.close()
  }
}

function channel(): Mesh {
  if (!mesh) throw new Error('pair or connect first')
  return mesh
}

async function close() {
  streams.clear()
  const old = mesh
  mesh = undefined
  await old?.close()
}

async function handle(request: Record<string, unknown>): Promise<unknown> {
  switch (request.op) {
    case 'pair': {
      const raw = String(request.uri)
      if (!raw.startsWith('aa-pair://')) throw new Error('invalid invitation')
      const payload = JSON.parse(Buffer.from(raw.slice('aa-pair://'.length), 'base64url').toString('utf8'))
      deviceId = payload.deviceId
      devicePub = payload.deviceIdentityPub
      mesh = await open(devicePub)
      const paired = await mesh.unary<unknown, { clientId: string; directoryKey: unknown }>(content, 'pair', {
        pairingId: payload.pairingId, pairingSecret: payload.psk, clientIdentityPub: identity.publicKey,
        clientSecret: secret, label: String(request.label ?? 'e2e client'), platform: 'cli',
      }, { instance: deviceId })
      clientId = paired.clientId
      return { deviceId, clientId, directoryKey: paired.directoryKey }
    }
    case 'connect': {
      await close()
      mesh = await open(typeof request.devicePub === 'string' ? request.devicePub : devicePub)
      await mesh.unary(content, 'request', { method: 'GET', path: '/e2ee/v1/directory-key' }, options())
      return { clientId, ready: { deviceId, clientId } }
    }
    case 'request':
      return channel().unary(content, 'request', { method: request.method, path: request.path, body: request.body ?? null }, options())
    case 'subscribe':
    case 'subscribeTerminal': {
      const sub = String(++nextSubscription)
      const stream = channel().serverStream<unknown, Record<string, unknown>>(content, 'subscribe',
        request.op === 'subscribe'
          ? { stream: 'session', sessionId: request.sessionId, afterCursor: request.afterCursor ?? null }
          : { stream: 'terminal', terminalId: request.terminalId, fromSeq: request.fromSeq ?? 0 },
        options(),
      )
      streams.set(sub, stream)
      void (async () => {
        try {
          for await (const event of stream) write({ event, sub })
        } catch (error) {
          if (streams.has(sub)) write({ closed: error instanceof MeshCallError ? error.code : 'closed' })
        } finally {
          streams.delete(sub)
        }
      })()
      return { sub }
    }
    case 'unsubscribe': {
      const sub = String(request.sub)
      const stream = streams.get(sub)
      streams.delete(sub)
      await stream?.cancel()
      return {}
    }
    case 'close':
      await close()
      return {}
    case 'identity':
      return { clientPub: identity.publicKey, clientId }
    default:
      throw new Error('unknown operation ' + request.op)
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line) as Record<string, unknown>
  handle(request).then(
    result => write({ id: request.id, ok: true, result }),
    (error: Error) => write({ id: request.id, ok: false, error: error.message, code: error instanceof MeshCallError ? error.code : null }),
  )
}).on('close', () => { void close().finally(() => process.exit(0)) })
write({ ready: true })
