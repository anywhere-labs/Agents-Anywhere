/** A use-case failure carrying the AA error code the Server and clients expect. */
export class UseCaseError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'UseCaseError'
  }
}
