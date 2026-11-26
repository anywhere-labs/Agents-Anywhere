/**
 * Local-First `meshcall-router` host for a work machine.
 *
 * Keeps a single RPC transport path across both offline local usage and remote cloud usage:
 *   - Spawns Go `meshcall-router` bound to `127.0.0.1` with a generated 0600 `local-router-auth.json`
 *     (no `anonymous` user).
 *   - Issues a device registration token so `ConnectorHost` mounts on the local Router the exact same way
 *     it mounts on remote Routers.
 *   - Lets Desktop, local CLI, third-party local SDKs, or a local MCP bridge request scoped `mt_` tokens
 *     without touching any remote server.
 */

import { pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

import {
  findRouterBinary,
  LocalRouter,
  Mesh,
  Router,
  RouterCredentials,
  type IssuedToken,
  type OpenedTunnel,
  type RouterScope,
} from "meshcall";

export interface LocalRouterHostOptions {
  /** Directory storing 0600 auth & discovery files. */
  dataDir: string;
  /** Listen host (defaults to 127.0.0.1). */
  host?: string;
  /** Listen port (defaults to 0 for an ephemeral port). */
  port?: number;
  /** Optional explicit path to `meshcall-router` binary. */
  binaryPath?: string;
  /** Optional CORS origins for local browser/WebView HTTP calls. */
  httpCorsOrigins?: string[];
}

export interface LocalRouterDescriptor {
  url: string;
  http_url: string;
  device_id?: string;
  started_at: string;
}

const DEVICE_SERVICES = [
  "aa.v3.Sessions",
  "aa.v3.Terminals",
  "aa.v3.Device",
  "aa.v3.DeviceAdmin",
] as const;

const TUNNEL_SERVICES = [
  "aa.v3.Sessions",
  "aa.v3.Terminals",
  "aa.v3.Device",
] as const;

export function resolveLocalRouterBinary(explicit?: string): string {
  if (explicit && existsSync(explicit)) return explicit;
  const env = process.env.MESHCALL_ROUTER_BINARY;
  if (env && existsSync(env)) return env;
  return findRouterBinary();
}

function hashRouterPassword(password: string): string {
  const salt = randomBytes(16);
  const key = pbkdf2Sync(password, salt, 600_000, 32, "sha256");
  return `pbkdf2-sha256$600000$${salt.toString("hex")}$${key.toString("hex")}`;
}

export class LocalRouterHost {
  readonly options: LocalRouterHostOptions;
  #router: LocalRouter | undefined;
  #adminMesh: Mesh | undefined;
  #authFile: string;
  #descriptorFile: string;
  #password = "";

  constructor(options: LocalRouterHostOptions) {
    this.options = options;
    this.#authFile = path.join(options.dataDir, "local-router-auth.json");
    this.#descriptorFile = path.join(options.dataDir, "local-router.json");
  }

  get url(): string {
    if (!this.#router) throw new Error("LocalRouterHost is not started");
    return this.#router.url;
  }

  get httpUrl(): string {
    if (!this.#router) throw new Error("LocalRouterHost is not started");
    return this.#router.httpUrl;
  }

  get isRunning(): boolean {
    return this.#router !== undefined;
  }

  async start(deviceId?: string): Promise<LocalRouterDescriptor> {
    if (this.#router) {
      return {
        url: this.url,
        http_url: this.httpUrl,
        ...(deviceId ? { device_id: deviceId } : {}),
        started_at: new Date().toISOString(),
      };
    }

    await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    this.#password = randomBytes(24).toString("base64url");
    const authPayload = {
      users: [
        {
          username: "local",
          password_hash: hashRouterPassword(this.#password),
          roles: ["client", "server"],
          register: [...DEVICE_SERVICES],
          call: [
            ...DEVICE_SERVICES.map((s) => `${s}/*`),
            "meshcall.router.v1.AuthService/*",
            "meshcall.router.v1.TunnelService/*",
            "meshcall.router.v1.Registry/*",
          ],
        },
      ],
    };
    await writeFile(this.#authFile, `${JSON.stringify(authPayload, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(this.#authFile, 0o600);

    const binaryPath = resolveLocalRouterBinary(this.options.binaryPath);
    const router = await LocalRouter.start({
      host: this.options.host ?? "127.0.0.1",
      port: this.options.port ?? 0,
      authFile: this.#authFile,
      binaryPath,
      ...(this.options.httpCorsOrigins ? { httpCorsOrigins: this.options.httpCorsOrigins } : {}),
    });
    this.#router = router;

    try {
      const mesh = await Mesh.connect(new Router(router.url), {
        credentials: RouterCredentials.basic("local", this.#password),
      });
      this.#adminMesh = mesh;
    } catch (error) {
      await router.close();
      this.#router = undefined;
      throw error;
    }

    const descriptor: LocalRouterDescriptor = {
      url: router.url,
      http_url: router.httpUrl,
      ...(deviceId ? { device_id: deviceId } : {}),
      started_at: new Date().toISOString(),
    };
    await writeFile(this.#descriptorFile, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(this.#descriptorFile, 0o600);
    return descriptor;
  }

  /** Issue a device registration token bound to `deviceId` on the local Router. */
  async issueDeviceToken(deviceId: string, ttlSeconds = 7 * 24 * 3600): Promise<IssuedToken> {
    const admin = this.#requireAdmin();
    const scopes: RouterScope[] = DEVICE_SERVICES.map(
      (service): RouterScope => ({
        service,
        register: true,
        instance_ids: [deviceId],
      }),
    );
    return admin.auth.issueToken(scopes, ttlSeconds, { principal: `device:${deviceId}` });
  }

  /**
   * Issue a scoped client/SDK/MCP token on the local Router.
   * Note: encrypted devices still enforce `requireE2EPeer`, so direct tokens only work on normal devices
   * (use `openLocalTunnel` with `e2eKey` for encrypted devices).
   */
  async issueLocalToken(options: {
    principal?: string;
    services?: string[];
    methods?: string[];
    ttlSeconds?: number;
  } = {}): Promise<IssuedToken> {
    const admin = this.#requireAdmin();
    const services = options.services ?? [...TUNNEL_SERVICES];
    const methods = options.methods ?? ["*"];
    const scopes: RouterScope[] = services.map((service) => ({ service, methods }));
    return admin.auth.issueToken(scopes, options.ttlSeconds ?? 3600, {
      principal: options.principal ?? "local:client",
    });
  }

  /** Open a local tunnel (plain or E2E) to `deviceId` through the local Router. */
  async openLocalTunnel(options: {
    deviceId: string;
    principal?: string;
    ttlSeconds?: number;
    e2eKey?: string;
  }): Promise<OpenedTunnel> {
    const admin = this.#requireAdmin();
    return admin.tunnels.open({
      instance: options.deviceId,
      scopes: [...TUNNEL_SERVICES],
      principal: options.principal ?? "local:desktop",
      ttlSeconds: options.ttlSeconds ?? 4 * 3600,
      ...(options.e2eKey ? { e2eKey: options.e2eKey } : {}),
    });
  }

  async stop(): Promise<void> {
    const mesh = this.#adminMesh;
    this.#adminMesh = undefined;
    if (mesh) await mesh.close().catch(() => undefined);
    const router = this.#router;
    this.#router = undefined;
    if (router) await router.close().catch(() => undefined);
    await unlink(this.#descriptorFile).catch(() => undefined);
  }

  #requireAdmin(): Mesh {
    if (!this.#adminMesh) throw new Error("LocalRouterHost is not started");
    return this.#adminMesh;
  }
}
