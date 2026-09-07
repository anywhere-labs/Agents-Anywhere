import config from "../config.json";
import { readJsonFile, writeJsonFile } from "./json-store";

export type DesktopServerConnection = {
  serverUrl: string;
  apiNamespace: string;
  oauthWebOrigin: string;
};

export type DesktopLoginErrorCode = "invalidServer" | "serverUnavailable" | "invalidHealth" | "serverTimeout" | "oauth";

export type DesktopOAuthStartResult =
  | { status: "opened"; authorizeUrl: string }
  | { status: "error"; code: DesktopLoginErrorCode; error: string };

export class DesktopServerError extends Error {
  constructor(readonly code: DesktopLoginErrorCode, message: string) {
    super(message);
  }
}

export function normalizeServerOrigin(value: string): string {
  try {
    const input = value.trim();
    if (!input) throw new Error();
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash ||
      (pathname && pathname !== config.apiNamespace)) throw new Error();
    return url.origin;
  } catch {
    throw new DesktopServerError("invalidServer", "Enter an HTTP or HTTPS server address without credentials, query parameters, or a page path.");
  }
}

export function resolveDesktopServer(
  value = config.cloud.serverUrl,
  options: { env?: NodeJS.ProcessEnv; development?: boolean } = {},
): DesktopServerConnection {
  const serverUrl = normalizeServerOrigin(value);
  const env = options.env ?? {};
  const configuredOrigin = env.WORKBENCH_API_ORIGIN?.trim() || env.AGENTS_ANYWHERE_API?.trim();
  const usesConfiguredServer = configuredOrigin && normalizeServerOrigin(configuredOrigin) === serverUrl;
  const namespace = usesConfiguredServer
    ? env.WORKBENCH_API_NAMESPACE ?? env.AGENTS_ANYWHERE_API_NAMESPACE ?? config.apiNamespace
    : config.apiNamespace;
  let oauthWebOrigin = serverUrl === config.cloud.serverUrl ? config.cloud.oauthWebOrigin : serverUrl;
  const explicitWebOrigin = usesConfiguredServer && env.WORKBENCH_OAUTH_WEB_ORIGIN?.trim();
  if (explicitWebOrigin) {
    oauthWebOrigin = normalizeServerOrigin(explicitWebOrigin);
  } else if (options.development) {
    const url = new URL(oauthWebOrigin);
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.port === "8000") {
      url.port = "5174";
      oauthWebOrigin = url.origin;
    }
  }
  return {
    serverUrl,
    apiNamespace: namespace.trim().replace(/^\/+|\/+$/g, "").replace(/^(.+)$/, "/$1"),
    oauthWebOrigin,
  };
}

export async function checkDesktopServer(
  server: DesktopServerConnection,
  fetcher: typeof fetch,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.healthTimeoutMs);
  try {
    const response = await fetcher(`${server.serverUrl}${server.apiNamespace}/health`, {
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new DesktopServerError("serverUnavailable", `Server health check failed (${response.status}).`);
    const payload = await response.json().catch(() => null) as { status?: unknown } | null;
    if (payload?.status !== "ok") {
      throw new DesktopServerError("invalidHealth", "The address did not return a healthy Agents Anywhere server.");
    }
  } catch (error) {
    if (controller.signal.aborted) throw new DesktopServerError("serverTimeout", "The server health check timed out.");
    if (error instanceof DesktopServerError) throw error;
    throw new DesktopServerError("serverUnavailable", "Could not reach the server. Check the address and your network connection.");
  } finally {
    clearTimeout(timeout);
  }
}

export class DesktopServerStore {
  private connection: DesktopServerConnection;
  private saved = false;

  constructor(private readonly filePath: string, fallback: DesktopServerConnection) {
    const stored = readJsonFile<DesktopServerConnection | null>(filePath, null);
    try {
      if (stored && typeof stored.apiNamespace === "string") {
        this.connection = {
          serverUrl: normalizeServerOrigin(stored.serverUrl),
          apiNamespace: stored.apiNamespace.replace(/^\/+|\/+$/g, "").replace(/^(.+)$/, "/$1"),
          oauthWebOrigin: normalizeServerOrigin(stored.oauthWebOrigin),
        };
        this.saved = true;
      } else {
        this.connection = fallback;
      }
    } catch {
      this.connection = fallback;
    }
  }

  get(): DesktopServerConnection {
    return { ...this.connection };
  }

  getSaved(): DesktopServerConnection | null {
    return this.saved ? this.get() : null;
  }

  save(connection: DesktopServerConnection): void {
    writeJsonFile(this.filePath, connection);
    this.connection = { ...connection };
    this.saved = true;
  }
}
