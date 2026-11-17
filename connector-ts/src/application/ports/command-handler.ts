import type { CommandReceipt } from './conversation-store.js'

/**
 * A command handler returns its result body (`CommandAck.r`); throwing a coded error rejects the command. A handler
 * whose effect is a store write passes `receipt` to that write, so effect and receipt commit together.
 */
export type CommandHandler = (payload: Record<string, unknown>, context: CommandHandlerContext) => Promise<Record<string, unknown>>

export interface CommandHandlerContext {
  readonly commandId: string
  readonly inputDigest: string | null
  readonly actor: string
  /** Always set by `CommandInbox`; absent when a handler is called directly (tests, tools). */
  readonly receipt?: CommandReceipt
}
