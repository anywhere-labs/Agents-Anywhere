import type { EventMethod, EventPayloads } from '../../generated/device-meshcall/v1_0/payloads.js'
import type { RuntimeStatusEvent } from '../../generated/device-meshcall/v1_0/runtime-status-event.js'

export type { EventMethod } from '../../generated/device-meshcall/v1_0/payloads.js'

/** One of the `runtime.status` facts device-meshcall 1.0 defines. */
export type ContractRuntimeStatus = RuntimeStatusEvent['status']

/** The contract's `runtime.status` fact named `event` (`goal.state.updated`, `runtime.types`, …). */
export type ContractStatusOf<E extends string> = Extract<ContractRuntimeStatus, { event: E }>

/** `runtime.status` as the device emits it. */
export type RuntimeStatusPayload = {
  readonly runtimeId: string
  readonly sessionId?: string | null
  readonly status: ContractRuntimeStatus
  readonly capabilities?: RuntimeStatusEvent['capabilities']
}

/** `LinkAttachItem.p` by `LinkAttachItem.m`, as the device emits it. */
export type LiveEventPayloads = { readonly [M in EventMethod]: M extends 'runtime.status' ? RuntimeStatusPayload : EventPayloads[M] }

/** An emitted event with its method, discriminated by `method`. */
export type LiveEvent = { readonly [M in EventMethod]: { readonly method: M; readonly payload: LiveEventPayloads[M] } }[EventMethod]

/**
 * Lossy live facts the device pushes to the Server on `Link/attach` (06-protocols.md §2.5): runtime status,
 * notices, queue state, capability and catalog changes, port events. They are current-state projections that
 * clients can re-read, so losing one is harmless; nothing here is persisted.
 */
export interface LiveEvents {
  /** `method` is the v2 event name (`runtime.notice.updated`, `runtime.queue.updated`, …); `payload` its `LinkAttachItem.p`. */
  emit<M extends EventMethod>(method: M, payload: LiveEventPayloads[M]): void
}
