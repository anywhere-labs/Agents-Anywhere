export class ApiException extends Error {
  readonly statusCode: number | null;
  readonly errorCode: string | null;

  constructor(message: string, statusCode: number | null = null, errorCode: string | null = null) {
    super(message);
    this.name = 'ApiException';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

export function errorMessageFrom(error: Object): string {
  if (error instanceof ApiException) {
    return error.message;
  }
  if (error instanceof Error) {
    const message = error.message;
    if (message.length > 0) {
      return message;
    }
  }
  return 'Something went wrong.';
}
