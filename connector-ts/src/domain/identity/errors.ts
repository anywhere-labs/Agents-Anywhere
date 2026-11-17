/**
 * Inputs the v2 identity rules reject (the Python implementation raises ValueError / UnicodeEncodeError).
 * They are rejected here too, instead of deriving a different identity.
 */
export class IdentityInputError extends Error {
  override readonly name = 'IdentityInputError'
}
