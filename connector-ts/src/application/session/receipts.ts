import { createHash } from 'node:crypto'

import type { CommandReceipt } from '../ports/index.js'

export interface CommandContext {
  readonly commandId: string | null
  /** Digest the client computed over the plaintext; the device computes one when absent. */
  readonly inputDigest: string | null
  /** Who asked (`usr_…`), for `createdBy` of queue items. */
  readonly actor: string
  /**
   * The command's receipt (CommandInbox): the use case hands it to the write that is the command's effect, so the
   * receipt commits in the same transaction and a retry after a crash replays it instead of running again.
   */
  readonly receipt?: CommandReceipt | null
}

/** The receipt with the ack body the use case already knows (null: none to write). */
export function withResult(receipt: CommandReceipt | null | undefined, result: Record<string, unknown> | null): CommandReceipt | null {
  return receipt === null || receipt === undefined ? null : { ...receipt, result }
}

export function digestOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}
