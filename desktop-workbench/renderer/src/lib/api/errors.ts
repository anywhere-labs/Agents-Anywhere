export type ApiErrorKind =
  | "network"
  | "http"
  | "unauthorized"
  | "forbidden"
  | "notFound"
  | "validation"
  | "server"
  | "unknown";

export type ApiErrorPayload = {
  status: number;
  detail: string;
  kind: ApiErrorKind;
  code?: string;
  payload?: unknown;
  url?: string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly kind: ApiErrorKind;
  readonly code?: string;
  readonly payload?: unknown;
  readonly url?: string;

  constructor({ status, detail, kind, code, payload, url }: ApiErrorPayload) {
    super(detail || (status ? `HTTP ${status}` : "Network error"));
    this.name = "ApiError";
    this.status = status;
    this.detail = detail || this.message;
    this.kind = kind;
    this.code = code;
    this.payload = payload;
    this.url = url;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (error instanceof ApiError) return error.detail || fallback;
  if (error instanceof Error) return error.message || fallback;
  return fallback;
}

export function apiErrorKind(status: number): ApiErrorKind {
  if (status === 0) return "network";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status === 422) return "validation";
  if (status >= 500) return "server";
  if (status >= 400) return "http";
  return "unknown";
}

export function extractErrorPayload(payload: unknown): {
  detail: string;
  code?: string;
} {
  if (typeof payload === "string") return { detail: payload };
  if (!payload || typeof payload !== "object") return { detail: "" };

  const record = payload as Record<string, unknown>;
  const detail = record.detail;
  if (typeof detail === "string") {
    return { detail, code: stringValue(record.code) };
  }
  if (detail && typeof detail === "object") {
    const detailRecord = detail as Record<string, unknown>;
    const message = stringValue(detailRecord.message);
    const code = stringValue(detailRecord.code);
    if (message) return { detail: message, code };
    if (code) return { detail: code, code };
    return { detail: stringifyDetail(detail), code };
  }

  const message = stringValue(record.message);
  const code = stringValue(record.code);
  if (message) return { detail: message, code };
  if (code) return { detail: code, code };
  return { detail: detail == null ? "" : String(detail), code };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stringifyDetail(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
