/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact terminal-output-item. Do not edit; run `yarn contracts:generate`. */

export type M = "terminal.replay" | "terminal.output" | "terminal.exited"

/**
 * Item of ``Workspace/terminalOutput`` (the v2 terminal relay frames).
 *
 * * ``terminal.replay`` ``{terminalId, seq, dataBase64, terminal}``: the scrollback (up to 512 KiB)
 *   ending at ``seq``. Always the first item; sent again when the reader fell behind the scrollback,
 *   and the client then redraws from it.
 * * ``terminal.output`` ``{terminalId, seq, dataBase64}``: output after the previous item, in order.
 * * ``terminal.exited`` ``{terminalId, exitCode, reason}``: the process exited (``exit``), the
 *   terminal was closed (``closed``) or expired; the stream ends after it.
 */
export interface TerminalOutputItem {
  m: M
  p?: P
  [k: string]: unknown
}
export interface P {
  [k: string]: unknown
}
