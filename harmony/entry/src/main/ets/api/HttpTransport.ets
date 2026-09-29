import { rcp } from '@kit.RemoteCommunicationKit';
import { AAApiError, defaultErrorMessage } from './ApiError';
import { parseJsonObject } from './ApiJson';
import { apiUrl, apiUrlCandidates, rememberApiUrl, shouldTryLegacyApi } from './ApiUrls';
import { normalizeServerOrigin } from './ServerOrigin';
import { AALog } from '../common/AAAppLog';

/**
 * HTTP transport.
 *
 * Port of the request portion of `api/ApiClient.kt`.
 *
 * Built on `@kit.RemoteCommunicationKit` (rcp) rather than `@ohos.net.http`
 * because the Server's API uses `PATCH` for session, project and connector
 * updates, and `http.RequestMethod` has no PATCH member. rcp takes an arbitrary
 * method plus a per-request timeout, which also lets the multipart boundary and
 * the read timeout keep Android's exact values.
 *
 * Behaviour that must stay identical:
 *  - every request carries `Accept: application/json` and
 *    `ngrok-skip-browser-warning: true`;
 *  - `Authorization: Bearer <token>` is attached only when the token is non-blank;
 *  - a bodyless POST/PUT/PATCH still sends a zero-length JSON body, because some
 *    Server deployments distinguish it from a missing body;
 *  - an unknown origin is probed at `/api/v2` and then at the unprefixed route,
 *    and the style that answered is remembered per origin;
 *  - a 401 with a non-blank bearer token raises the unauthorized callback so the
 *    app can sign out, and never clears a token that has since been replaced.
 */

const DEFAULT_CONNECT_TIMEOUT_MS: number = 10_000;
const DEFAULT_READ_TIMEOUT_MS: number = 15_000;
const UPLOAD_READ_TIMEOUT_MS: number = 60_000;

/** Request methods the API uses. rcp accepts these as plain strings. */
export class HttpMethod {
  static readonly GET: string = 'GET';
  static readonly POST: string = 'POST';
  static readonly PUT: string = 'PUT';
  static readonly PATCH: string = 'PATCH';
  static readonly DELETE: string = 'DELETE';
}

/** One file part of a multipart upload. */
export interface UploadFilePart {
  name: string;
  mediaType: string;
  bytes: ArrayBuffer;
}

export class HttpTransport {
  private readonly onUnauthorized: (accessToken: string) => void;
  /** One session for the lifetime of the transport; rcp pools connections in it. */
  private session: rcp.Session | null = null;

  constructor(onUnauthorized: (accessToken: string) => void = () => {}) {
    this.onUnauthorized = onUnauthorized;
  }

  getJson(serverUrl: string, path: string, token: string = ''): Promise<Object> {
    return this.requestJson(serverUrl, path, HttpMethod.GET, undefined, token);
  }

  postJson(
    serverUrl: string,
    path: string,
    token: string,
    body: Object,
    readTimeoutMs: number = DEFAULT_READ_TIMEOUT_MS,
  ): Promise<Object> {
    return this.requestJson(
      serverUrl, path, HttpMethod.POST, JSON.stringify(body), token, readTimeoutMs,
    );
  }

  /** POST with a zero-length body, still sent with a JSON content type. */
  postEmpty(serverUrl: string, path: string, token: string): Promise<Object> {
    return this.requestJson(serverUrl, path, HttpMethod.POST, '', token);
  }

  /** POST whose body is a bare JSON array, used by the bulk session endpoints. */
  postJsonArray(serverUrl: string, path: string, token: string, body: string[]): Promise<Object> {
    return this.requestJson(serverUrl, path, HttpMethod.POST, JSON.stringify(body), token);
  }

  /**
   * POST with `application/x-www-form-urlencoded`. Used only by the OAuth token
   * exchange, which carries no bearer token.
   */
  postForm(serverUrl: string, path: string, fields: Map<string, string>): Promise<Object> {
    const encoded: string[] = [];
    fields.forEach((value: string, name: string) => {
      encoded.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    });
    return this.requestJson(
      serverUrl, path, HttpMethod.POST, encoded.join('&'), '', DEFAULT_READ_TIMEOUT_MS,
      'application/x-www-form-urlencoded',
    );
  }

  patchJson(serverUrl: string, path: string, token: string, body: Object): Promise<Object> {
    return this.requestJson(serverUrl, path, HttpMethod.PATCH, JSON.stringify(body), token);
  }

  putJson(serverUrl: string, path: string, token: string, body: Object): Promise<Object> {
    return this.requestJson(serverUrl, path, HttpMethod.PUT, JSON.stringify(body), token);
  }

  deleteJson(serverUrl: string, path: string, token: string): Promise<Object> {
    return this.requestJson(serverUrl, path, HttpMethod.DELETE, undefined, token);
  }

  /**
   * GETs a binary resource.
   *
   * Used by the attachment endpoints, which answer with the file itself rather
   * than JSON. A JSON error body is still parsed for its message, so a rejected
   * download reports why instead of failing silently.
   */
  async getBytes(serverUrl: string, path: string, token: string): Promise<ArrayBuffer> {
    const response: rcp.Response = await this.send(
      apiUrl(serverUrl, path),
      HttpMethod.GET,
      this.baseHeaders(token, '*/*'),
      undefined,
      DEFAULT_READ_TIMEOUT_MS,
    );
    if (response.statusCode < 200 || response.statusCode > 299) {
      this.notifyUnauthorized(response.statusCode, token);
      const text: string = responseBodyText(response);
      throw new AAApiError(
        parseErrorMessage(text) ?? defaultErrorMessage(response.statusCode),
        response.statusCode,
        parseErrorCode(text),
      );
    }
    const body: ArrayBuffer | undefined = response.body;
    // `destination` defaults to an in-memory buffer; an absent body is an empty
    // file rather than an error, so the caller can report it by size.
    return body === undefined ? new ArrayBuffer(0) : body;
  }

  /**
   * Fetches a document and requires an HTML content type.
   *
   * Used to confirm that a self-hosted address actually serves the web sign-in
   * page, so a user typing an API-only host gets a specific error instead of a
   * blank embedded browser.
   */
  async requireHtmlDocument(serverUrl: string, path: string = '/'): Promise<void> {
    const normalizedPath: string = path.startsWith('/') ? path : `/${path}`;
    const origin: string | null = normalizeServerOrigin(serverUrl);
    if (origin === null) {
      throw new AAApiError('The server URL is invalid.');
    }
    const response: rcp.Response = await this.send(
      `${origin}${normalizedPath}`,
      HttpMethod.GET,
      this.baseHeaders('', 'text/html'),
      undefined,
      DEFAULT_READ_TIMEOUT_MS,
    );
    const contentType: string = readHeader(response, 'content-type');
    const successful: boolean = response.statusCode >= 200 && response.statusCode <= 299;
    if (!successful || !contentType.toLowerCase().includes('text/html')) {
      throw new AAApiError(
        `The web login is unavailable at ${origin}. Check the server's web login deployment.`,
        response.statusCode,
      );
    }
  }

  /**
   * Uploads files as `multipart/form-data` under the fixed field name `files`,
   * which the Server's attachment endpoint requires.
   *
   * The boundary keeps Android's `AA-<millis>` shape. It is transmitted in the
   * Content-Type header and parsed by the Server, so the value itself is not
   * part of the contract, but matching it keeps packet captures comparable.
   */
  async postMultipart(
    serverUrl: string,
    path: string,
    files: UploadFilePart[],
    token: string,
  ): Promise<Object> {
    const parts: rcp.FormFieldFileValue[] = [];
    for (const file of files) {
      // rcp names the payload field `contentOrPath`: either a local path or an
      // in-memory `{ content }` wrapper, so bytes must be wrapped.
      const payload: rcp.FileContent = { content: file.bytes };
      const part: rcp.FormFieldFileValue = {
        // `ContentType` is a literal union, so the value is asserted rather than
        // widened to string.
        contentType: (file.mediaType.length > 0
          ? file.mediaType
          : 'application/octet-stream') as rcp.ContentType,
        remoteFileName: file.name,
        contentOrPath: payload,
      };
      parts.push(part);
    }
    const fields: rcp.MultipartFormFields = { files: parts };
    const boundary: string = `AA-${Date.now()}`;
    const form: rcp.MultipartForm = new rcp.MultipartForm(fields, boundary);

    // No explicit Content-Type: rcp adds it together with the boundary.
    const response: rcp.Response = await this.send(
      apiUrl(serverUrl, path),
      HttpMethod.POST,
      this.baseHeaders(token, ''),
      form,
      UPLOAD_READ_TIMEOUT_MS,
    );
    const text: string = responseBodyText(response);
    if (response.statusCode < 200 || response.statusCode > 299) {
      this.notifyUnauthorized(response.statusCode, token);
      throw new AAApiError(
        parseErrorMessage(text) ?? defaultErrorMessage(response.statusCode),
        response.statusCode,
        parseErrorCode(text),
      );
    }
    return parseJsonObject(text);
  }

  private async requestJson(
    serverUrl: string,
    path: string,
    method: string,
    bodyText: string | undefined,
    token: string,
    readTimeoutMs: number = DEFAULT_READ_TIMEOUT_MS,
    contentType: string = 'application/json; charset=utf-8',
  ): Promise<Object> {
    const candidates: string[] = apiUrlCandidates(serverUrl, path);
    let lastError: AAApiError | null = null;

    for (let index = 0; index < candidates.length; index++) {
      const url: string = candidates[index];
      let response: rcp.Response;
      try {
        response = await this.send(
          url,
          method,
          this.baseHeaders(token, 'application/json', contentType),
          bodyText,
          readTimeoutMs,
        );
      } catch (error) {
        const apiError: AAApiError = toApiError(error);
        lastError = apiError;
        if (apiError.statusCode !== null || index === candidates.length - 1) {
          throw apiError;
        }
        continue;
      }

      const text: string = responseBodyText(response);
      const responseContentType: string = readHeader(response, 'content-type');
      const successful: boolean = response.statusCode >= 200 && response.statusCode <= 299;
      const hasNextCandidate: boolean = index < candidates.length - 1;
      if (hasNextCandidate
        && shouldTryLegacyApi(response.statusCode, successful, responseContentType, text)) {
        AALog.debug(`Retrying ${path} on the legacy route`);
        continue;
      }

      if (!successful) {
        this.notifyUnauthorized(response.statusCode, token);
        throw new AAApiError(
          parseErrorMessage(text) ?? defaultErrorMessage(response.statusCode),
          response.statusCode,
          parseErrorCode(text),
        );
      }

      const parsed: Object = parseJsonObject(text);
      rememberApiUrl(serverUrl, url);
      return parsed;
    }
    throw lastError ?? new AAApiError('The server returned an invalid response.');
  }

  /** Issues one request on the shared session, translating transport failures. */
  private async send(
    url: string,
    method: string,
    headers: rcp.RequestHeaders,
    content: rcp.RequestContent | undefined,
    readTimeoutMs: number,
  ): Promise<rcp.Response> {
    try {
      const configuration: rcp.Configuration = {
        transfer: {
          timeout: {
            connectMs: DEFAULT_CONNECT_TIMEOUT_MS,
            transferMs: readTimeoutMs,
          },
        },
      };
      const request: rcp.Request = new rcp.Request(
        url, method, headers, content, undefined, undefined, configuration,
      );
      return await this.requireSession().fetch(request);
    } catch (error) {
      throw toApiError(error);
    }
  }

  private requireSession(): rcp.Session {
    if (this.session === null) {
      try {
        this.session = rcp.createSession();
      } catch (error) {
        throw toApiError(error);
      }
    }
    return this.session;
  }

  private baseHeaders(
    token: string,
    accept: string,
    contentType: string = '',
  ): rcp.RequestHeaders {
    const headers: rcp.RequestHeaders = {
      'accept': accept.length > 0 ? accept : 'application/json',
      'ngrok-skip-browser-warning': 'true',
    };
    if (contentType.length > 0) {
      headers['content-type'] = contentType;
    }
    if (token.length > 0) {
      headers['authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  /**
   * Reports a token that a non-HTTP connection rejected.
   *
   * The terminal stream is a raw WebSocket, so its 401 never passes through
   * `requestJson`; this is the same entry point Android's `ApiClient.
   * notifyUnauthorized` offers to `TerminalApi`.
   */
  notifyUnauthorizedToken(token: string): void {
    this.notifyUnauthorized(401, token);
  }

  private notifyUnauthorized(statusCode: number, token: string): void {
    if (statusCode !== 401 || token.length === 0) {
      return;
    }
    try {
      this.onUnauthorized(token);
    } catch (error) {
      AALog.warn(`Unauthorized callback failed: ${errorText(error)}`);
    }
  }
}

/** Normalizes any thrown value into an `AAApiError` with Android's copy. */
export function toApiError(error: Object): AAApiError {
  if (error instanceof AAApiError) {
    return error;
  }
  const message: string = errorText(error);
  if (message.includes('Server URL must be an HTTP(S) origin')) {
    return new AAApiError('The server URL is invalid.');
  }
  return new AAApiError('Could not reach the server. Check the URL and network.');
}

function errorText(error: Object): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}

/** Reads the response body as text; rcp returns null for an empty body. */
function responseBodyText(response: rcp.Response): string {
  const text: string | null = response.toString();
  return text === null ? '' : text;
}

/**
 * Case-insensitive header lookup.
 *
 * `ResponseHeaders` types `content-type` directly, but a proxy may re-cast the
 * header name, so both spellings are checked.
 */
function readHeader(response: rcp.Response, name: string): string {
  const headers: rcp.ResponseHeaders = response.headers;
  const lower: string | string[] | undefined = headers[name.toLowerCase()];
  if (typeof lower === 'string') {
    return lower;
  }
  if (Array.isArray(lower) && lower.length > 0) {
    return lower[0];
  }
  const direct: string | string[] | undefined = headers[name];
  if (typeof direct === 'string') {
    return direct;
  }
  if (Array.isArray(direct) && direct.length > 0) {
    return direct[0];
  }
  return '';
}

/**
 * Extracts a user-facing message from an error body.
 *
 * Mirrors Android's `parseErrorMessage`: only `detail` is consulted, and it may
 * be a string, an object carrying `message` or `code`, or an array of
 * validation errors carrying `msg`.
 */
export function parseErrorMessage(responseText: string): string | null {
  if (responseText.trim().length === 0) {
    return null;
  }
  try {
    const body: Record<string, Object> = JSON.parse(responseText) as Record<string, Object>;
    const detail: Object = body['detail'];
    if (detail === undefined || detail === null) {
      return null;
    }
    if (typeof detail === 'string') {
      return detail.length > 0 ? detail : null;
    }
    if (Array.isArray(detail)) {
      const first: Record<string, Object> = (detail as Object[])[0] as Record<string, Object>;
      if (first !== undefined && first !== null) {
        const msg: Object = first['msg'];
        if (typeof msg === 'string' && msg.length > 0) {
          return msg;
        }
      }
      return null;
    }
    if (typeof detail === 'object') {
      const object: Record<string, Object> = detail as Record<string, Object>;
      const message: Object = object['message'];
      if (typeof message === 'string' && message.length > 0) {
        return message;
      }
      const code: Object = object['code'];
      if (typeof code === 'string' && code.length > 0) {
        return code;
      }
      return null;
    }
    return null;
  } catch (error) {
    return null;
  }
}

/** Extracts the stable machine-readable error code, when the body carries one. */
export function parseErrorCode(responseText: string): string | null {
  if (responseText.trim().length === 0) {
    return null;
  }
  try {
    const body: Record<string, Object> = JSON.parse(responseText) as Record<string, Object>;
    const detail: Object = body['detail'];
    const carrier: Record<string, Object> =
      (detail !== undefined && detail !== null && typeof detail === 'object' && !Array.isArray(detail))
        ? detail as Record<string, Object>
        : body;
    const code: Object = carrier['code'];
    return typeof code === 'string' && code.length > 0 ? code : null;
  } catch (error) {
    return null;
  }
}
