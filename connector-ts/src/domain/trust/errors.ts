/**
 * Trust rule violations. `code` is an AA error code (runtime-errors 1.1 / e2ee 1.0) clients already know, so the
 * channel can report it unchanged.
 */
export type TrustErrorCode =
  | 'pairing_expired'
  | 'pairing_limit'
  | 'e2ee_not_paired'
  | 'client_id_mismatch'
  | 'device_pin_mismatch'
  | 'approver_not_authorized'
  | 'local_confirmation_required'
  | 'invalid_argument'

export class TrustError extends Error {
  public constructor(
    public readonly code: TrustErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TrustError'
  }
}
