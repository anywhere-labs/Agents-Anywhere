/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact plan-document-request. Do not edit; run `yarn contracts:generate`. */

export type Planid = string | null
export type Revision = number | null
export type Sessionid = string

/**
 * Without ``planId``: every revision (``{plans}``); with ``planId`` and ``revision``: that one (``{document}``).
 */
export interface PlanDocumentRequest {
  planId?: Planid
  revision?: Revision
  sessionId: Sessionid
  [k: string]: unknown
}
