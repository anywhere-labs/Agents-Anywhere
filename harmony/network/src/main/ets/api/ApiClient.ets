import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { ApiException } from 'common';
import { apiUrlCandidates, normalizeServerOrigin, rememberApiUrl } from 'common';
import {
  objGetOptString,
  objGetString,
  parseJsonRecord,
  recordOrNull
} from 'common';

const CONNECT_TIMEOUT_MS = 10000;
const READ_TIMEOUT_MS = 15000;
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const METHOD_OVERRIDE_HEADER = 'X-HTTP-Method-Override';
const DOWNLOAD_READ_TIMEOUT_MS = 60000;

export interface UploadFilePart {
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface FetchedFileData {
  bytes: Uint8Array;
  mediaType: string;
}

function concatByteChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function sanitizeMultipartFileName(name: string): string {
  let cleaned = '';
  for (let i = 0; i < name.length; i++) {
    const ch = name.charAt(i);
    if (ch === '"' || ch === '\r' || ch === '\n' || ch === '\\') {
      cleaned += '_';
    } else {
      cleaned += ch;
    }
  }
  return cleaned;
}

function buildMultipartBody(fieldName: string, parts: UploadFilePart[], boundary: string): Uint8Array {
  const encoder = new util.TextEncoder();
  const chunks: Uint8Array[] = [];
  const dashBoundary = `--${boundary}`;
  for (const part of parts) {
    const header = `${dashBoundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${sanitizeMultipartFileName(part.fileName)}"\r\n` +
      `Content-Type: ${part.mediaType}\r\n\r\n`;
    chunks.push(encoder.encodeInto(header));
    chunks.push(part.bytes);
    chunks.push(encoder.encodeInto('\r\n'));
  }
  chunks.push(encoder.encodeInto(`${dashBoundary}--\r\n`));
  return concatByteChunks(chunks);
}

function isJsonContentType(contentType: string): boolean {
  const lowered = contentType.toLowerCase();
  return lowered.includes('application/json') || lowered.includes('+json');
}

function shouldTryLegacyApi(statusCode: number, successful: boolean, contentType: string, responseText: string): boolean {
  if (statusCode === 405) {
    return true;
  }
  if (isJsonContentType(contentType)) {
    return false;
  }
  if (statusCode === 404) {
    return true;
  }
  const loweredText = responseText.trim().toLowerCase();
  const looksLikeHtml = contentType.toLowerCase().includes('text/html') ||
    loweredText.startsWith('<!doctype') ||
    loweredText.startsWith('<html');
  return successful && looksLikeHtml;
}

function defaultApiErrorMessage(statusCode: number): string {
  if (statusCode === 401) {
    return 'Unauthorized request.';
  }
  if (statusCode === 404) {
    return 'Endpoint was not found on this server.';
  }
  return `Request failed with status ${statusCode}.`;
}

function parseApiErrorMessage(responseText: string): string | null {
  let body: Record<string, Object>;
  try {
    body = parseJsonRecord(responseText);
  } catch (error) {
    return null;
  }
  const detail = body['detail'];
  if (typeof detail === 'string' && detail.length > 0) {
    return detail;
  }
  const detailRecord = recordOrNull(detail);
  if (detailRecord !== null) {
    const message = objGetString(detailRecord, 'message', '');
    if (message.length > 0) {
      return message;
    }
    const code = objGetString(detailRecord, 'code', '');
    if (code.length > 0) {
      return code;
    }
    return null;
  }
  if (Array.isArray(detail)) {
    const list = detail as Object[];
    const first = recordOrNull(list[0]);
    if (first !== null) {
      const message = objGetString(first, 'msg', '');
      if (message.length > 0) {
        return message;
      }
    }
  }
  return null;
}

function parseApiErrorCode(responseText: string): string | null {
  let body: Record<string, Object>;
  try {
    body = parseJsonRecord(responseText);
  } catch (error) {
    return null;
  }
  const detailRecord = recordOrNull(body['detail']);
  if (detailRecord !== null) {
    return objGetOptString(detailRecord, 'code');
  }
  return objGetOptString(body, 'code');
}

function resultAsText(result: string | Object | ArrayBuffer): string {
  if (typeof result === 'string') {
    return result;
  }
  if (result instanceof ArrayBuffer) {
    return '';
  }
  if (typeof result === 'object' && result !== null) {
    return JSON.stringify(result);
  }
  return '';
}

function responseContentType(header: Object): string {
  const record = header as Record<string, Object>;
  const direct = record['content-type'];
  if (typeof direct === 'string') {
    return direct;
  }
  const capitalized = record['Content-Type'];
  if (typeof capitalized === 'string') {
    return capitalized;
  }
  return '';
}

export class ApiClient {
  private readonly onUnauthorized: ((accessToken: string) => void) | undefined;

  constructor(onUnauthorized?: (accessToken: string) => void) {
    this.onUnauthorized = onUnauthorized;
  }

  notifyUnauthorized(statusCode: number, authorizationToken: string | null): void {
    if (statusCode !== 401) {
      return;
    }
    if (authorizationToken === null || authorizationToken.length === 0) {
      return;
    }
    const handler = this.onUnauthorized;
    if (handler !== undefined) {
      handler(authorizationToken);
    }
  }

  async requireHtmlDocument(serverUrl: string, path: string = '/'): Promise<void> {
    const origin = normalizeServerOrigin(serverUrl);
    if (origin === null) {
      throw new ApiException('The server URL is invalid.');
    }
    const normalizedPath = path.startsWith('/') ? path : '/' + path;
    const httpRequest = http.createHttp();
    try {
      const headers: Record<string, string> = {
        'Accept': 'text/html',
        'ngrok-skip-browser-warning': 'true'
      };
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.GET,
        header: headers,
        connectTimeout: CONNECT_TIMEOUT_MS,
        readTimeout: READ_TIMEOUT_MS,
        usingCache: false
      };
      const response = await httpRequest.request(origin + normalizedPath, options);
      const code: number = response.responseCode;
      const contentType = responseContentType(response.header);
      const ok = code >= 200 && code < 300;
      if (!ok || !contentType.toLowerCase().includes('text/html')) {
        throw new ApiException(
          `The web login is unavailable at ${origin}. Check the server's web login deployment.`, code);
      }
    } catch (error) {
      if (error instanceof ApiException) {
        throw error;
      }
      throw new ApiException('Could not reach the server. Check the URL and network.');
    } finally {
      httpRequest.destroy();
    }
  }

  async getJson(serverUrl: string, path: string, authorizationToken: string | null = null): Promise<Record<string, Object>> {
    return this.requestJson(serverUrl, path, http.RequestMethod.GET, null, null, authorizationToken, READ_TIMEOUT_MS);
  }

  async postJson(serverUrl: string, path: string, body: Record<string, Object> | null,
    authorizationToken: string | null = null, readTimeoutMs: number = READ_TIMEOUT_MS): Promise<Record<string, Object>> {
    const bodyText = body === null ? null : JSON.stringify(body);
    return this.requestJson(serverUrl, path, http.RequestMethod.POST, bodyText,
      JSON_CONTENT_TYPE, authorizationToken, readTimeoutMs);
  }

  async postJsonArray(serverUrl: string, path: string, body: Object[],
    authorizationToken: string | null = null): Promise<Record<string, Object>> {
    return this.requestJson(serverUrl, path, http.RequestMethod.POST, JSON.stringify(body),
      JSON_CONTENT_TYPE, authorizationToken, READ_TIMEOUT_MS);
  }

  async postForm(serverUrl: string, path: string, fields: Record<string, string>): Promise<Record<string, Object>> {
    const pairs: string[] = [];
    const names = Object.keys(fields);
    for (const name of names) {
      pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(fields[name])}`);
    }
    return this.requestJson(serverUrl, path, http.RequestMethod.POST, pairs.join('&'),
      'application/x-www-form-urlencoded', null, READ_TIMEOUT_MS);
  }

  async patchJson(serverUrl: string, path: string, body: Record<string, Object>,
    authorizationToken: string | null = null): Promise<Record<string, Object>> {
    // RequestMethod.PATCH only exists from API 26; on older runtimes the enum
    // member resolves to undefined and we fall back to POST + method override.
    const nativePatch: http.RequestMethod | undefined = http.RequestMethod.PATCH;
    const method = nativePatch === undefined ? http.RequestMethod.POST : nativePatch;
    const methodOverride = nativePatch === undefined ? 'PATCH' : null;
    return this.requestJson(serverUrl, path, method, JSON.stringify(body),
      JSON_CONTENT_TYPE, authorizationToken, READ_TIMEOUT_MS, methodOverride);
  }

  async putJson(serverUrl: string, path: string, body: Record<string, Object>,
    authorizationToken: string | null = null): Promise<Record<string, Object>> {
    return this.requestJson(serverUrl, path, http.RequestMethod.PUT, JSON.stringify(body),
      JSON_CONTENT_TYPE, authorizationToken, READ_TIMEOUT_MS);
  }

  async deleteJson(serverUrl: string, path: string,
    authorizationToken: string | null = null): Promise<Record<string, Object>> {
    return this.requestJson(serverUrl, path, http.RequestMethod.DELETE, null, null,
      authorizationToken, READ_TIMEOUT_MS);
  }

  private async requestJson(serverUrl: string, path: string, method: http.RequestMethod,
    bodyData: string | Uint8Array | null, contentType: string | null, authorizationToken: string | null,
    readTimeoutMs: number, methodOverride: string | null = null): Promise<Record<string, Object>> {
    const origin = normalizeServerOrigin(serverUrl);
    if (origin === null) {
      throw new ApiException('The server URL is invalid.');
    }
    let effectiveBody = bodyData;
    if (effectiveBody === null && (method === http.RequestMethod.POST ||
      method === http.RequestMethod.PUT || method === http.RequestMethod.PATCH)) {
      effectiveBody = '{}';
    }
    const bodyToSend = effectiveBody === null ? '' : effectiveBody;
    const candidates = apiUrlCandidates(origin, path);
    for (let index = 0; index < candidates.length; index++) {
      // Only non-final candidates may fall back to the legacy route; the final
      // candidate keeps its ApiException (status code + detail) intact.
      const allowLegacyFallback = index < candidates.length - 1;
      const result = await this.requestJsonOnce(candidates[index], method, bodyToSend, contentType,
        authorizationToken, origin, readTimeoutMs, allowLegacyFallback, methodOverride);
      if (result !== null) {
        return result;
      }
    }
    throw new ApiException('The server returned an invalid response.');
  }

  async postMultipart(serverUrl: string, path: string, fieldName: string, parts: UploadFilePart[],
    authorizationToken: string | null, readTimeoutMs: number): Promise<Record<string, Object>> {
    const origin = normalizeServerOrigin(serverUrl);
    if (origin === null) {
      throw new ApiException('The server URL is invalid.');
    }
    const boundary = `AA-${Date.now().toString(36)}-${Math.floor(Math.random() * 2147483647).toString(36)}`;
    const body = buildMultipartBody(fieldName, parts, boundary);
    const contentType = `multipart/form-data; boundary=${boundary}`;
    const candidates = apiUrlCandidates(origin, path);
    for (let index = 0; index < candidates.length; index++) {
      const allowLegacyFallback = index < candidates.length - 1;
      const result = await this.requestJsonOnce(candidates[index], http.RequestMethod.POST, body,
        contentType, authorizationToken, origin, readTimeoutMs, allowLegacyFallback);
      if (result !== null) {
        return result;
      }
    }
    throw new ApiException('The server returned an invalid response.');
  }

  async fetchUrlBytes(url: string, maxBytes: number): Promise<FetchedFileData> {
    const httpRequest = http.createHttp();
    try {
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.GET,
        header: {
          'Accept': '*/*'
        },
        connectTimeout: CONNECT_TIMEOUT_MS,
        readTimeout: DOWNLOAD_READ_TIMEOUT_MS,
        usingCache: false,
        expectDataType: http.HttpDataType.ARRAY_BUFFER
      };
      const response = await httpRequest.request(url, options);
      const code: number = response.responseCode;
      if (code < 200 || code >= 300) {
        throw new ApiException(`Download failed with status ${code}.`, code);
      }
      const payload = response.result;
      if (!(payload instanceof ArrayBuffer)) {
        throw new ApiException('The download returned an unexpected response.');
      }
      if (payload.byteLength > maxBytes) {
        throw new ApiException('The file is too large.');
      }
      const fetched: FetchedFileData = {
        bytes: new Uint8Array(payload),
        mediaType: responseContentType(response.header)
      };
      return fetched;
    } catch (error) {
      if (error instanceof ApiException) {
        throw error;
      }
      throw new ApiException('Could not download the file. Check the URL and network.');
    } finally {
      httpRequest.destroy();
    }
  }

  private async requestJsonOnce(url: string, method: http.RequestMethod, bodyData: string | Uint8Array,
    contentType: string | null, authorizationToken: string | null, origin: string,
    readTimeoutMs: number, allowLegacyFallback: boolean,
    methodOverride: string | null = null): Promise<Record<string, Object> | null> {
    const httpRequest = http.createHttp();
    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        'ngrok-skip-browser-warning': 'true'
      };
      if (contentType !== null) {
        headers['Content-Type'] = contentType;
      }
      if (methodOverride !== null) {
        headers[METHOD_OVERRIDE_HEADER] = methodOverride;
      }
      if (authorizationToken !== null && authorizationToken.length > 0) {
        headers['Authorization'] = `Bearer ${authorizationToken}`;
      }
      const options: http.HttpRequestOptions = {
        method: method,
        header: headers,
        connectTimeout: CONNECT_TIMEOUT_MS,
        readTimeout: readTimeoutMs,
        usingCache: false
      };
      if (typeof bodyData === 'string') {
        if (bodyData.length > 0) {
          options.extraData = bodyData;
        }
      } else {
        options.extraData = bodyData.buffer;
      }
      const response = await httpRequest.request(url, options);
      const responseText = resultAsText(response.result);
      const contentTypeHeader = responseContentType(response.header);
      const code: number = response.responseCode;
      const ok = code >= 200 && code < 300;
      if (allowLegacyFallback && shouldTryLegacyApi(code, ok, contentTypeHeader, responseText)) {
        return null;
      }
      if (!ok) {
        this.notifyUnauthorized(code, authorizationToken);
        throw new ApiException(
          parseApiErrorMessage(responseText) ?? defaultApiErrorMessage(code),
          code,
          parseApiErrorCode(responseText));
      }
      const parsed = parseJsonRecord(responseText);
      rememberApiUrl(origin, url);
      return parsed;
    } catch (error) {
      if (error instanceof ApiException) {
        throw error;
      }
      throw new ApiException('Could not reach the server. Check the URL and network.');
    } finally {
      httpRequest.destroy();
    }
  }
}
