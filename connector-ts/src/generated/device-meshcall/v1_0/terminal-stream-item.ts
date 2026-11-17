/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact terminal-stream-item. Do not edit; run `yarn contracts:generate`. */

/**
 * base64 bytes (replay, output)
 */
export type Data = string | null
export type Exitcode = number | null
export type Reason = string | null
export type Seq = number | null
export type Type = "replay" | "output" | "exit"

/**
 * A message of the terminal WebSocket, unchanged: ``replay`` (the scrollback, always first and again when
 * the reader fell behind), ``output`` in order, then ``exit``.
 */
export interface TerminalStreamItem {
  data?: Data
  exitCode?: Exitcode
  reason?: Reason
  seq?: Seq
  type: Type
  [k: string]: unknown
}
