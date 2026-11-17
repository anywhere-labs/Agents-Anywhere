/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact select-command. Do not edit; run `yarn contracts:generate`. */

export type Externalsessionid = string | null
export type Optionid = string | null
export type Runtime = string | null
export type Runtimeid = string | null
export type Selections = {
  [k: string]: string | boolean | null
} | null
export type Sessionid = string
export type Value = string | boolean | null

/**
 * ``selections`` (catalog type -> selection id; null keeps the current one), or one ``optionId``/``value``.
 */
export interface SelectCommand {
  externalSessionId?: Externalsessionid
  optionId?: Optionid
  runtime?: Runtime
  runtimeId?: Runtimeid
  selections?: Selections
  sessionId: Sessionid
  value?: Value
  [k: string]: unknown
}
