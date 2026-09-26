/**
 * API error type.
 *
 * Ported from `ApiException` in
 * android/app/src/main/java/com/agentsanywhere/app/api/ApiClient.kt.
 *
 * `statusCode` and `errorCode` are carried separately because the UI branches on
 * them: 401 signs the user out, and `errorCode` is matched against stable server
 * codes such as `project_name_conflict` or `DSH_CONCURRENT_WRITER_DETECTED`.
 */
export class AAApiError extends Error {
  readonly statusCode: number | null;
  readonly errorCode: string | null;

  constructor(message: string, statusCode: number | null = null, errorCode: string | null = null) {
    super(message);
    this.name = 'AAApiError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }

  /** True when the failure means the stored credential is no longer accepted. */
  isUnauthorized(): boolean {
    return this.statusCode === 401;
  }
}

/** Raised when a response body does not match the contract the client expects. */
export class AAResponseFormatError extends AAApiError {
  constructor(message: string) {
    super(message);
    this.name = 'AAResponseFormatError';
  }
}

/**
 * Default messages, matching the Kotlin `defaultErrorMessage` so the same
 * fallback copy reaches the user on both platforms.
 */
export function defaultErrorMessage(statusCode: number): string {
  if (statusCode === 401) {
    return 'Unauthorized request.';
  }
  if (statusCode === 404) {
    return 'Endpoint was not found on this server.';
  }
  return `Request failed with status ${statusCode}.`;
}
