/**
 * Domain rule violations. `code` is the AA error code clients already know (queue codes, conflicts),
 * so the application layer can hand it to the Server unchanged.
 */
export type ConversationErrorCode =
  | 'session_busy'
  | 'queue_full'
  | 'queue_item_not_found'
  | 'queue_item_sending'
  | 'queue_order_mismatch'
  | 'interaction_not_found'
  | 'interaction_conflict'
  | 'delivery_conflict'
  | 'invalid_transition'
  | 'invalid_argument'
  | 'clock_regression'

export class ConversationError extends Error {
  public constructor(
    public readonly code: ConversationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ConversationError'
  }
}
