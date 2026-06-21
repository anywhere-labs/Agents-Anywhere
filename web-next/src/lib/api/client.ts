import {
  ApiError,
  apiErrorKind,
  extractErrorPayload
} from "@/lib/api/errors";

export type ApiTokenProvider = () => string | null | undefined;

export type ApiClientOptions = {
  baseUrl?: string;
  getToken?: ApiTokenProvider;
  fetcher?: typeof fetch;
};

export type ApiRequestOptions = Omit<RequestInit, "body"> & {
  body?: BodyInit | Record<string, unknown> | unknown[] | null;
  token?: string | null;
  auth?: boolean;
  query?: Record<string, string | number | boolean | null | undefined>;
};

export class ApiClient {
  private readonly baseUrl: string;
  private readonly getToken?: ApiTokenProvider;
  private readonly fetcher: typeof fetch;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "";
    this.getToken = options.getToken;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  }

  get<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: options.method ?? "GET" });
  }

  post<T>(
    path: string,
    body?: ApiRequestOptions["body"],
    options: ApiRequestOptions = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: "POST", body });
  }

  put<T>(
    path: string,
    body?: ApiRequestOptions["body"],
    options: ApiRequestOptions = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: "PUT", body });
  }

  patch<T>(
    path: string,
    body?: ApiRequestOptions["body"],
    options: ApiRequestOptions = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: "PATCH", body });
  }

  delete<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "DELETE" });
  }

  async request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers = new Headers(options.headers);
    const body = normalizeBody(options.body);
    if (body != null && !headers.has("content-type") && isJsonBody(options.body)) {
      headers.set("content-type", "application/json");
    }
    headers.set("accept", headers.get("accept") ?? "application/json");

    const token = options.token ?? (options.auth === false ? null : this.getToken?.());
    if (token) headers.set("authorization", `Bearer ${token}`);

    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...options,
        body,
        headers
      });
    } catch (error) {
      throw new ApiError({
        status: 0,
        kind: "network",
        detail: error instanceof Error ? error.message : "network error",
        url
      });
    }

    if (response.status === 204) return undefined as T;

    const payload = await readPayload(response);
    if (!response.ok) {
      const normalized = extractErrorPayload(payload);
      throw new ApiError({
        status: response.status,
        kind: apiErrorKind(response.status),
        detail: normalized.detail || `HTTP ${response.status}`,
        code: normalized.code,
        payload,
        url
      });
    }

    return payload as T;
  }

  private buildUrl(
    path: string,
    query?: ApiRequestOptions["query"],
  ): string {
    const base = this.baseUrl;
    const raw = path.startsWith("http") ? path : `${base}${path}`;
    if (!query) return raw;
    const url = new URL(raw, typeof window === "undefined" ? "http://localhost" : window.location.origin);
    for (const [key, value] of Object.entries(query)) {
      if (value == null) continue;
      url.searchParams.set(key, String(value));
    }
    if (path.startsWith("http") || base) return url.toString();
    return `${url.pathname}${url.search}${url.hash}`;
  }
}

export const apiClient = new ApiClient();

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeBody(body: ApiRequestOptions["body"]): BodyInit | null | undefined {
  if (body == null) return body;
  if (typeof body === "string") return body;
  if (body instanceof FormData) return body;
  if (body instanceof Blob) return body;
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) return body;
  if (body instanceof URLSearchParams) return body;
  return JSON.stringify(body);
}

function isJsonBody(body: ApiRequestOptions["body"]): boolean {
  if (body == null) return false;
  if (typeof body === "string") return false;
  if (body instanceof FormData) return false;
  if (body instanceof Blob) return false;
  if (body instanceof ArrayBuffer) return false;
  if (ArrayBuffer.isView(body)) return false;
  if (body instanceof URLSearchParams) return false;
  return true;
}
