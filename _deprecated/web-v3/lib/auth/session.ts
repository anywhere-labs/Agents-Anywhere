/** The server refused the refresh token (revoked, rotated away or expired): the user has to sign in again. */
export class SessionExpiredError extends Error {
  override name = "SessionExpiredError"
  constructor(message = "Your session has expired; sign in again") {
    super(message)
  }
}

/** sessionStorage key the sign-in page reads to say why the user is back there (value: the account's email). */
export const SESSION_EXPIRED_FLAG = "aa-v3-session-expired"
