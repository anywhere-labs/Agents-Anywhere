import type { CommandMethod, CommandPayloads } from '../../generated/device-meshcall/v1_0/payloads.js'
import type { CommandReceipt } from './conversation-store.js'

/**
 * A command handler of `M` takes its request (`CommandCall.p`, already checked by `CommandInbox`) and returns its
 * result body (`CommandAck.r`); throwing a coded error rejects the command. A handler whose effect is a store write
 * passes `receipt` to that write, so effect and receipt commit together.
 */
export type CommandHandler<M extends CommandMethod> = (
  payload: CommandPayloads[M]['request'],
  context: CommandHandlerContext,
) => Promise<CommandPayloads[M]['response']>

/** Handlers by business method name (`preview.open`, `runtime.apply`, …). */
export type CommandHandlers = { readonly [M in CommandMethod]?: CommandHandler<M> }

export interface CommandHandlerContext {
  readonly commandId: string
  readonly inputDigest: string | null
  readonly actor: string
  /** Always set by `CommandInbox`; absent when a handler is called directly (tests, tools). */
  readonly receipt?: CommandReceipt
}
