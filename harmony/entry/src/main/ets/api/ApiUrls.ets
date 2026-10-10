import { normalizeServerOrigin } from './ServerOrigin';

/**
 * API path and route-style rules.
 *
 * Port of `api/ApiUrls.kt`.
 *
 * The Server mounts every product endpoint under `/api/v2`, but older
 * deployments only expose the unprefixed routes. Android probes both and
 * remembers which one worked, per origin, and this module reproduces that
 * exactly — including the rule that a JSON error body must never trigger the
 * legacy fallback, because a JSON 404 is a real answer rather than a missing
 * route.
 */

const API_NAMESPACE: string = '/api/v2';

/** Which route style an origin has been observed to serve. */
export enum ApiRouteStyle {
  Namespaced = 0,
  Legacy = 1,
  Unknown = 2,
}

const apiRouteStyles: Map<string, ApiRouteStyle> = new Map();

/** Adds the `/api/v2` prefix unless the path already carries it. */
export function apiPath(path: string): string {
  const normalized: string = path.startsWith('/') ? path : `/${path}`;
  const queryIndex: number = firstIndexOfAny(normalized, '?', '#');
  const pathEnd: number = queryIndex >= 0 ? queryIndex : normalized.length;
  const pathname: string = normalized.substring(0, pathEnd);
  if (pathname === API_NAMESPACE || pathname.startsWith(`${API_NAMESPACE}/`)) {
    return normalized;
  }
  return `${API_NAMESPACE}${normalized}`;
}

/** Strips the `/api/v2` prefix for deployments that serve unprefixed routes. */
export function legacyApiPath(path: string): string {
  const normalized: string = path.startsWith('/') ? path : `/${path}`;
  if (normalized === API_NAMESPACE) {
    return '/';
  }
  if (normalized.startsWith(`${API_NAMESPACE}/`)) {
    return normalized.substring(API_NAMESPACE.length);
  }
  return normalized;
}

/** Resolves a product path using the route style already learned for this origin. */
export function apiUrl(serverUrl: string, path: string): string {
  const origin: string | null = normalizeServerOrigin(serverUrl);
  if (origin === null) {
    throw new Error('Server URL must be an HTTP(S) origin.');
  }
  if (apiRouteStyles.get(origin) === ApiRouteStyle.Legacy) {
    return `${origin}${legacyApiPath(path)}`;
  }
  return `${origin}${apiPath(path)}`;
}

/**
 * Candidate URLs to try, in order. An unknown origin is probed namespaced
 * first; a learned origin is not probed at all.
 */
export function apiUrlCandidates(serverUrl: string, path: string): string[] {
  const origin: string | null = normalizeServerOrigin(serverUrl);
  if (origin === null) {
    throw new Error('Server URL must be an HTTP(S) origin.');
  }
  const style: ApiRouteStyle = apiRouteStyles.get(origin) ?? ApiRouteStyle.Unknown;
  if (style === ApiRouteStyle.Namespaced) {
    return [`${origin}${apiPath(path)}`];
  }
  if (style === ApiRouteStyle.Legacy) {
    return [`${origin}${legacyApiPath(path)}`];
  }
  return [`${origin}${apiPath(path)}`, `${origin}${legacyApiPath(path)}`];
}

/**
 * Records the style that actually answered. Android only calls this after a
 * successful response, so a failing probe cannot poison the cache.
 */
export function rememberApiUrl(serverUrl: string, resolvedUrl: string): void {
  const origin: string | null = normalizeServerOrigin(serverUrl);
  if (origin === null) {
    return;
  }
  const resolvedPath: string = pathOf(resolvedUrl);
  const namespaced: boolean = resolvedPath === API_NAMESPACE
    || resolvedPath.startsWith(`${API_NAMESPACE}/`);
  apiRouteStyles.set(origin, namespaced ? ApiRouteStyle.Namespaced : ApiRouteStyle.Legacy);
}

export function usesLegacyApiRoute(serverUrl: string): boolean {
  const origin: string | null = normalizeServerOrigin(serverUrl);
  if (origin === null) {
    return false;
  }
  return apiRouteStyles.get(origin) === ApiRouteStyle.Legacy;
}

/** Rewrites an API URL to its WebSocket equivalent, honouring the learned style. */
export function webSocketApiUrl(serverUrl: string, path: string): string {
  const httpUrl: string = apiUrl(serverUrl, path);
  if (httpUrl.startsWith('https://')) {
    return `wss://${httpUrl.substring('https://'.length)}`;
  }
  return `ws://${httpUrl.substring('http://'.length)}`;
}

/**
 * Decides whether the next candidate should be attempted.
 *
 * `405` always means the route exists but not for this method shape. A JSON body
 * means the Server answered, so the response is final even when it is a 404. A
 * non-JSON 404, or an HTML page returned with a 2xx, means the request reached
 * something that is not the API.
 */
export function shouldTryLegacyApi(
  statusCode: number,
  successful: boolean,
  contentType: string,
  responseText: string,
): boolean {
  if (statusCode === 405) {
    return true;
  }
  if (isJsonContentType(contentType)) {
    return false;
  }
  if (statusCode === 404) {
    return true;
  }
  const trimmed: string = responseText.trimStart();
  const looksLikeHtml: boolean = contentType.toLowerCase().includes('text/html')
    || trimmed.startsWith('<!DOCTYPE')
    || trimmed.startsWith('<html');
  return successful && looksLikeHtml;
}

function isJsonContentType(contentType: string): boolean {
  const lower: string = contentType.toLowerCase();
  return lower.includes('application/json') || lower.includes('+json');
}

/** Percent-encodes a path segment or query value. */
export function encodeUrlComponent(value: string): string {
  return encodeURIComponent(value);
}

function firstIndexOfAny(value: string, first: string, second: string): number {
  const firstIndex: number = value.indexOf(first);
  const secondIndex: number = value.indexOf(second);
  if (firstIndex < 0) {
    return secondIndex;
  }
  if (secondIndex < 0) {
    return firstIndex;
  }
  return Math.min(firstIndex, secondIndex);
}

/** Extracts the path portion of an absolute URL, without query or fragment. */
function pathOf(url: string): string {
  const schemeEnd: number = url.indexOf('://');
  const rest: string = schemeEnd >= 0 ? url.substring(schemeEnd + 3) : url;
  const slashIndex: number = rest.indexOf('/');
  if (slashIndex < 0) {
    return '';
  }
  let path: string = rest.substring(slashIndex);
  const cut: number = firstIndexOfAny(path, '?', '#');
  if (cut >= 0) {
    path = path.substring(0, cut);
  }
  return path;
}
