/**
 * Server origin normalization.
 *
 * Ported from `normalizeServerOrigin` / `usesLocalNetworkHost` in
 * android/app/src/main/java/com/agentsanywhere/app/api/ApiUrls.kt. Split into
 * its own module because both the persistence layer and the HTTP layer need it,
 * and the persistence layer must not depend on the transport.
 *
 * Behaviour worth preserving exactly:
 *  - A bare host defaults to http for local-network hosts and for anything with
 *    an explicit port, and to https otherwise.
 *  - A trailing `/api/v2` is tolerated and stripped, any other path is rejected.
 *  - userinfo, query and fragment are rejected.
 */

const API_NAMESPACE: string = '/api/v2';

/** True for localhost, `.local`, and the RFC1918 / loopback IPv4 literals. */
export function usesLocalNetworkHost(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '[::1]') {
    return true;
  }
  if (host.endsWith('.local')) {
    return true;
  }
  const parts: string[] = host.split('.');
  if (parts.length !== 4) {
    return false;
  }
  const octets: number[] = [];
  for (const part of parts) {
    // Reject anything that is not a plain decimal octet, including "01" and whitespace.
    if (part.length === 0 || !/^\d{1,3}$/.test(part)) {
      return false;
    }
    const value: number = Number.parseInt(part, 10);
    if (Number.isNaN(value) || value < 0 || value > 255) {
      return false;
    }
    octets.push(value);
  }
  if (octets[0] === 10 || octets[0] === 127) {
    return true;
  }
  if (octets[0] === 192 && octets[1] === 168) {
    return true;
  }
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
    return true;
  }
  return false;
}

interface ParsedOrigin {
  scheme: string;
  host: string;
  /** Empty when the authority carried no explicit port. */
  port: string;
  /** Path component without a trailing slash. */
  path: string;
}

/**
 * Minimal HTTP(S) authority parser.
 *
 * ArkTS has no `java.net.URI`, and `@ohos.url.URL` normalizes some of the cases
 * this function must reject, so the authority is parsed directly against the
 * same rules the Kotlin implementation relied on.
 */
function parseOriginCandidate(candidate: string): ParsedOrigin | null {
  const schemeEnd: number = candidate.indexOf('://');
  if (schemeEnd <= 0) {
    return null;
  }
  const scheme: string = candidate.substring(0, schemeEnd).toLowerCase();
  let rest: string = candidate.substring(schemeEnd + 3);

  // Strip fragment then query, which must both be absent for a valid origin.
  const fragmentIndex: number = rest.indexOf('#');
  if (fragmentIndex >= 0) {
    return null;
  }
  const queryIndex: number = rest.indexOf('?');
  if (queryIndex >= 0) {
    return null;
  }
  if (rest.includes('@')) {
    return null;
  }

  const slashIndex: number = rest.indexOf('/');
  let path: string = '';
  if (slashIndex >= 0) {
    path = rest.substring(slashIndex);
    rest = rest.substring(0, slashIndex);
  }
  while (path.endsWith('/')) {
    path = path.substring(0, path.length - 1);
  }

  let host: string = rest;
  let port: string = '';
  if (rest.startsWith('[')) {
    // IPv6 literal: keep the brackets, the port follows the closing bracket.
    const close: number = rest.indexOf(']');
    if (close < 0) {
      return null;
    }
    host = rest.substring(0, close + 1);
    const remainder: string = rest.substring(close + 1);
    if (remainder.length > 0) {
      if (!remainder.startsWith(':')) {
        return null;
      }
      port = remainder.substring(1);
    }
  } else {
    const colon: number = rest.lastIndexOf(':');
    if (colon >= 0) {
      host = rest.substring(0, colon);
      port = rest.substring(colon + 1);
    }
  }

  if (host.length === 0) {
    return null;
  }
  if (port.length > 0 && !/^\d{1,5}$/.test(port)) {
    return null;
  }
  return { scheme: scheme, host: host, port: port, path: path };
}

/**
 * Normalizes user input into an `scheme://host[:port]` origin, or returns null
 * when the input cannot be a server address.
 */
export function normalizeServerOrigin(serverUrl: string): string | null {
  let trimmed: string = serverUrl.trim();
  while (trimmed.endsWith('/')) {
    trimmed = trimmed.substring(0, trimmed.length - 1);
  }
  if (trimmed.length === 0) {
    return null;
  }

  let candidate: string = trimmed;
  if (!trimmed.includes('://')) {
    const authority: string = trimmed.split('/')[0];
    const hostPart: string = authority.split(':')[0].toLowerCase();
    if (hostPart.length === 0) {
      return null;
    }
    const scheme: string = (usesLocalNetworkHost(hostPart) || authority.includes(':')) ? 'http' : 'https';
    candidate = `${scheme}://${trimmed}`;
  }

  const parsed: ParsedOrigin | null = parseOriginCandidate(candidate);
  if (parsed === null) {
    return null;
  }
  if (parsed.scheme !== 'http' && parsed.scheme !== 'https') {
    return null;
  }
  if (parsed.path.length > 0 && parsed.path !== API_NAMESPACE) {
    return null;
  }

  const host: string = parsed.host.toLowerCase();
  if (host.length === 0) {
    return null;
  }
  const port: string = parsed.port.length > 0 ? `:${parsed.port}` : '';
  return `${parsed.scheme}://${host}${port}`;
}
