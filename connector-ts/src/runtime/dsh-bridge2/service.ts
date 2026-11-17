/**
 * `aa.dsh.v2.Sync` served by the TS Connector (contracts/dsh-bridge/2.0 "aa.dsh.v2.Sync").
 * The wire shape matches the Python service the plugin's generated `SyncServiceClient`
 * was made from: positional parameters, `{ok}` results, application error codes
 * `subscription_unknown` and `backend_unavailable` (retryable).
 */
import { MeshCallError, mutates, query, service, z, type RpcContext } from 'meshcall'
import { Bridge2Error, type Bridge2SyncRelay, type SnapshotPage, type SnapshotRequest } from './relay.js'

export const SYNC_SERVICE = 'aa.dsh.v2.Sync'

const json = z.looseObject({})
const batchSchema = z.object({
  subscriptionId: z.string(),
  batchSeq: z.int(),
  projectionVersion: z.int(),
  operations: z.array(json),
})
const ingestResult = z.object({ ok: z.boolean().default(true) })
const checkpointResult = z.object({ checkpoint: json.nullable().default(null) })
const snapshotRequest = z.object({
  captureId: z.string(),
  subscriptionId: z.string(),
  sessionId: z.string(),
  meta: json,
  throughSeq: z.int(),
})
const snapshotPage = z.object({ captureId: z.string(), items: z.array(json) })
const snapshotResult = z.object({ accepted: z.boolean(), quarantined: z.boolean().default(false), reason: z.string().nullable().default(null) })

/** Relay failures as the MeshCall errors a 2.0 plugin understands. */
export function syncFailure(error: unknown): MeshCallError {
  if (error instanceof MeshCallError) return error
  if (error instanceof Bridge2Error) return new MeshCallError(error.code, error.message, { retryable: error.retryable })
  return new MeshCallError('internal', error instanceof Error ? error.message : String(error))
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() } catch (error) { throw syncFailure(error) }
}

/**
 * The relay of the plugin connection currently served. One Connector serves one plugin
 * (the plugin holds a manager lock per rendezvous), so a single slot is enough; a call
 * while no relay is attached names an unknown subscription.
 */
export interface RelaySlot { current(): Bridge2SyncRelay | undefined }

function relayOf(slot: RelaySlot): Bridge2SyncRelay {
  const relay = slot.current()
  if (!relay) throw new MeshCallError('subscription_unknown', 'The Connector no longer runs this sync subscription')
  return relay
}

@service(SYNC_SERVICE, { description: 'Event batches and checkpoints from the DSH plugin.' })
export class SyncService {
  constructor(private readonly slot: RelaySlot) {}

  @mutates({ description: 'Ingest one batch of a subscription; returning is its acknowledgement.', idempotent: true,
    input: { batch: batchSchema }, response: ingestResult })
  async ingestBatch(batch: z.infer<typeof batchSchema>) {
    await mapped(() => relayOf(this.slot).ingestBatch(batch))
    return { ok: true }
  }

  @query({ description: 'The checkpoint the Connector stored for one native session.',
    input: { subscriptionId: z.string(), externalSessionId: z.string() }, output: checkpointResult })
  async loadCheckpoint(subscriptionId: string, externalSessionId: string) {
    const checkpoint = await mapped(() => relayOf(this.slot).loadCheckpoint(subscriptionId, externalSessionId))
    return { checkpoint: checkpoint ? { ...checkpoint } : null }
  }

  @mutates({ description: 'Store a checkpoint; withheld for a quarantined session.', idempotent: true,
    input: { subscriptionId: z.string(), externalSessionId: z.string(), checkpoint: json }, response: ingestResult })
  async saveCheckpoint(subscriptionId: string, externalSessionId: string, checkpoint: Record<string, unknown>) {
    await mapped(() => relayOf(this.slot).saveCheckpoint(subscriptionId, externalSessionId, checkpoint))
    return { ok: true }
  }

  @mutates({ description: 'Drop a checkpoint; the next baseline is a full capture.', idempotent: true,
    input: { subscriptionId: z.string(), externalSessionId: z.string() }, response: ingestResult })
  async deleteCheckpoint(subscriptionId: string, externalSessionId: string) {
    await mapped(() => relayOf(this.slot).deleteCheckpoint(subscriptionId, externalSessionId))
    return { ok: true }
  }

  @mutates({ description: 'Assemble a paged snapshot; the call returning means it was stored or quarantined.', idempotent: true,
    input: { request: snapshotRequest }, streamInput: snapshotPage, response: snapshotResult })
  async ingestSnapshot(request: SnapshotRequest, pages: AsyncIterable<SnapshotPage>, _context: RpcContext) {
    const result = await mapped(() => relayOf(this.slot).ingestSnapshot(request, pages))
    return { accepted: result.accepted, quarantined: result.quarantined ?? false, reason: result.reason ?? null }
  }
}
