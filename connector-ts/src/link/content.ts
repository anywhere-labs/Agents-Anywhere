import { createHash, timingSafeEqual } from 'node:crypto'
import { MeshCallError, z, type RpcContext } from 'meshcall'

import type { TunnelApi } from '../application/inbound/tunnel-api.js'
import type { ContentTrust } from '../application/inbound/channel-trust.js'
import { clientIdFor, TrustError } from '../domain/trust/index.js'
import { defineService } from '../mesh/index.js'

export const CONTENT_SERVICE = 'aa.device.v1.Content'
export const CONTENT_PRINCIPAL_PREFIX = 'aa-content-client/'
export const CONTROL_PRINCIPAL = 'aa-server-control'
export const CONTROL_SERVICES: ReadonlySet<string> = new Set(['aa.device.v1.Link', 'aa.device.v1.Commands'])
const MAX_QUEUED_BYTES = 16 * 1024 * 1024
const MAX_QUEUED_EVENTS = 1024
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
const platform = z.enum(['android', 'ios', 'web', 'desktop', 'cli'])
const pairRequest = z.strictObject({
  pairingId: z.string().min(1).max(128),
  pairingSecret: secret,
  clientIdentityPub: secret,
  clientSecret: secret,
  label: z.string().min(1).max(120),
  platform,
})
const contentRequest = z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1).max(4096),
  body: z.unknown().optional(),
})
const subscribeRequest = z.strictObject({
  stream: z.enum(['session', 'terminal', 'trust']).default('session'),
  sessionId: z.string().default(''),
  afterCursor: z.string().nullable().default(null),
  terminalId: z.string().nullish(),
  fromSeq: z.number().int().nonnegative().nullish(),
})

export interface DeviceContent {
  readonly publicKey: string
  readonly privateKey: string
  readonly service: object
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function matchesDigest(expected: string | undefined, actual: string): boolean {
  return expected !== undefined && /^[a-f0-9]{64}$/u.test(expected) &&
    timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))
}

function requireContentTunnel(context: RpcContext): void {
  if (context.tunnel?.sealed !== true || !context.tunnel.principal.startsWith(CONTENT_PRINCIPAL_PREFIX)) {
    throw new MeshCallError('permission_denied', 'This operation requires an encrypted content tunnel')
  }
}

function authorizedClient(trust: ContentTrust, context: RpcContext) {
  requireContentTunnel(context)
  const clientId = context.metadata['aa-content-client']
  const credential = secret.safeParse(context.metadata['aa-content-credential'])
  if (clientId && credential.success) {
    try {
      const grant = trust.authorize(clientId)
      if (matchesDigest(grant.meshCredentialDigest, digest(Buffer.from(credential.data, 'base64url')))) return grant
    } catch (error) {
      if (!(error instanceof TrustError)) throw error
    }
  }
  throw new MeshCallError('unauthenticated', 'Client has not been approved on this device', {
    details: { reason: 'e2ee_not_paired' },
  })
}

async function* contentEvents(api: TunnelApi, trust: ContentTrust, request: z.infer<typeof subscribeRequest>, context: RpcContext) {
  const caller = authorizedClient(trust, context)
  const queue: { event: Record<string, unknown>; bytes: number }[] = []
  let queuedBytes = 0
  let wake: (() => void) | undefined
  let ended: MeshCallError | undefined
  const notify = (): void => wake?.()
  let trustChanged = request.stream === 'trust'
  const unlisten = trust.onEvent(event => {
    if (event.type === 'ClientRevoked' && event.clientId === caller.clientId) {
      ended = new MeshCallError('permission_denied', 'Client access was revoked', {
        details: { reason: 'e2ee_not_paired' },
      })
      notify()
    } else if (request.stream === 'trust' && event.type === 'DirectoryKeyRotated') {
      trustChanged = true
      notify()
    }
  })
  context.signal.addEventListener('abort', notify, { once: true })
  let unsubscribe: (() => void) | undefined
  try {
    const target = request.stream
    if (target !== 'trust') unsubscribe = await api.subscribe(caller, {
      stream: target,
      sessionId: request.sessionId,
      afterCursor: request.afterCursor,
      ...(request.terminalId == null ? {} : { terminalId: request.terminalId }),
      ...(request.fromSeq == null ? {} : { fromSeq: request.fromSeq }),
    }, event => {
      if (ended || context.signal.aborted) return
      const bytes = Buffer.byteLength(JSON.stringify(event))
      if (queue.length >= MAX_QUEUED_EVENTS || queuedBytes + bytes > MAX_QUEUED_BYTES) {
        ended = new MeshCallError('resource_exhausted', 'Resume this subscription from the last received cursor')
        unsubscribe?.()
      } else {
        queue.push({ event, bytes })
        queuedBytes += bytes
      }
      notify()
    })
    while (!context.signal.aborted) {
      if (ended) throw ended
      if (trustChanged) {
        trustChanged = false
        const grant = await trust.directoryKeyGrant()
        if (ended) throw ended
        trust.authorize(caller.clientId)
        yield { type: 'e2ee.directory_key', ...grant }
        continue
      }
      const next = queue.shift()
      if (next) {
        queuedBytes -= next.bytes
        yield next.event
      } else {
        await new Promise<void>(resolve => { wake = resolve })
        wake = undefined
      }
    }
  } finally {
    unsubscribe?.()
    unlisten()
    context.signal.removeEventListener('abort', notify)
  }
}

export function deviceContent(api: TunnelApi, trust: ContentTrust, privateKey: Uint8Array): DeviceContent {
  const service = defineService(CONTENT_SERVICE, 'Locally approved client content over an encrypted MeshCall tunnel', [
    {
      name: 'pair',
      kind: 'unary',
      description: 'Redeem a local pairing invitation and persist the client credential.',
      request: pairRequest,
      handler: (async (request: z.infer<typeof pairRequest>, context: RpcContext) => {
        requireContentTunnel(context)
        const identity = Buffer.from(request.clientIdentityPub, 'base64url')
        const clientId = clientIdFor(identity)
        const meshCredentialDigest = digest(Buffer.from(request.clientSecret, 'base64url'))
        try {
          await trust.commitMeshPairing(request.pairingId, {
            clientId,
            identityPub: identity.toString('base64url'),
            label: request.label,
            platform: request.platform,
            meshCredentialDigest,
          }, expected => timingSafeEqual(expected, Buffer.from(request.pairingSecret, 'base64url')),
          expected => matchesDigest(expected, meshCredentialDigest))
        } catch (error) {
          if (error instanceof TrustError) throw new MeshCallError('permission_denied', error.message, {
            details: { reason: error.code },
          })
          throw error
        }
        const directoryKey = await trust.directoryKeyGrant()
        const grant = trust.authorize(clientId)
        return { clientId, grantedAt: grant.grantedAt, directoryKey }
      }) as never,
    },
    {
      name: 'request',
      kind: 'unary',
      description: 'Run a client API request on the device.',
      request: contentRequest,
      handler: (async (request: z.infer<typeof contentRequest>, context: RpcContext) => {
        const caller = authorizedClient(trust, context)
        if (request.method === 'GET' && request.path === '/e2ee/v1/directory-key') {
          return { status: 200, body: await trust.directoryKeyGrant() }
        }
        if (request.method === 'GET' && request.path === '/e2ee/v1/trust') {
          return { status: 200, body: trust.trustList() }
        }
        if (request.method === 'POST' && request.path === '/e2ee/v1/trust/revoke') {
          const client = z.object({ clientId: z.string().min(1) }).safeParse(request.body)
          if (!client.success) return { status: 400, body: { detail: { code: 'invalid_argument', message: 'clientId' } } }
          try {
            await trust.revokeClient(client.data.clientId)
            return { status: 200, body: trust.trustList() }
          } catch (error) {
            if (error instanceof TrustError) return { status: 409, body: { detail: { code: error.code, message: error.message } } }
            throw error
          }
        }
        return api.request(caller, { ...request, body: request.body ?? null })
      }) as never,
    },
    {
      name: 'subscribe',
      kind: 'server_stream',
      description: 'Stream session or terminal events to an approved client.',
      request: subscribeRequest,
      handler: ((request: z.infer<typeof subscribeRequest>, context: RpcContext) => contentEvents(api, trust, request, context)) as never,
    },
  ])
  return {
    publicKey: trust.state.identityPub,
    privateKey: Buffer.from(privateKey).toString('base64url'),
    service,
  }
}
