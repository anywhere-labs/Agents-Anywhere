/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact terminal-output-request. Do not edit; run `yarn contracts:generate`. */

export type Fromseq = number
export type Sessionid = string
export type Terminalid = string

/**
 * ``Workspace/terminalOutput``: opening subscribes to a terminal's output, cancelling unsubscribes.
 *
 * ``sessionId`` is the scope the terminal was created in (``terminal.create``'s ``sessionId``).
 */
export interface TerminalOutputRequest {
  fromSeq?: Fromseq
  sessionId: Sessionid
  terminalId: Terminalid
  [k: string]: unknown
}
