/**
 * v2 rejected these inputs with a Python exception (ValueError / UnicodeEncodeError).
 * v3 must reject the same inputs instead of deriving a different identity.
 */
export class IdentityInputError extends Error {
  override readonly name = 'IdentityInputError'
}
