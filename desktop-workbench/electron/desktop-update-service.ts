import fs from "node:fs";
import path from "node:path";
import { compareProductVersions, isNumericProductVersion } from "./desktop-product-version";
import { DesktopUpdateStore } from "./desktop-update-store";
import type {
  DesktopUpdateErrorCode,
  DesktopUpdateRelease,
  DesktopUpdateSnapshot,
} from "./desktop-update-types";

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
type Timer = ReturnType<typeof setTimeout>;

type DesktopUpdateServiceOptions = {
  currentVersion: string;
  currentVersionCode: number;
  platform: NodeJS.Platform;
  apiOrigin: () => string;
  apiNamespace: () => string;
  statePath: string;
  downloadDirectory: string;
  fetcher: Fetcher;
  openPath: (filePath: string) => Promise<string>;
  onState?: (state: DesktopUpdateSnapshot) => void;
  onLog?: (message: string) => void;
  automaticCheckDelayMs?: number;
  requestTimeoutMs?: number;
  uptimeMs?: () => number;
  now?: () => Date;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  allowInsecureHttp?: boolean;
};

type DesktopReleaseTarget = "desktop-macos" | "desktop-windows" | "desktop";

type HealthPayload = {
  status?: unknown;
  version?: unknown;
};

type ReleasePayload = {
  platform?: unknown;
  updateAvailable?: unknown;
  latestVersionCode?: unknown;
  latestVersionName?: unknown;
  downloadUrl?: unknown;
};

const DEFAULT_AUTOMATIC_CHECK_DELAY_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

export class DesktopUpdateService {
  private readonly store: DesktopUpdateStore;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly now: () => Date;
  private readonly supported: boolean;
  private state: DesktopUpdateSnapshot;
  private startPromise: Promise<DesktopUpdateSnapshot> | null = null;
  private automaticCheckTimer: Timer | null = null;
  private downloadPromise: Promise<DesktopUpdateSnapshot> | null = null;
  private downloadAbortController: AbortController | null = null;
  private downloadedInstallerPath: string | null = null;
  private disposed = false;

  constructor(private readonly options: DesktopUpdateServiceOptions) {
    this.store = new DesktopUpdateStore(options.statePath);
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.now = options.now ?? (() => new Date());
    this.supported = options.platform === "darwin" || options.platform === "win32";
    this.state = {
      supported: this.supported,
      currentVersion: options.currentVersion,
      currentVersionCode: options.currentVersionCode,
      serverVersion: null,
      phase: this.supported ? "checking-health" : "ready",
      forced: false,
      release: null,
      progress: null,
      errorCode: null,
    };
  }

  getState(): DesktopUpdateSnapshot {
    return cloneSnapshot(this.state);
  }

  start(): Promise<DesktopUpdateSnapshot> {
    if (this.startPromise) return this.startPromise;
    if (!this.supported) {
      this.startPromise = Promise.resolve(this.getState());
      return this.startPromise;
    }
    this.scheduleAutomaticCheck();
    this.startPromise = this.checkBackendCompatibility();
    return this.startPromise;
  }

  async checkNow(): Promise<DesktopUpdateSnapshot> {
    await this.start();
    if (this.disposed || !this.supported) return this.getState();
    try {
      await this.checkRelease();
    } catch (error) {
      this.log(`Desktop update check failed: ${errorMessage(error)}`);
      this.updateState({
        phase: this.state.forced ? "force-required" : "ready",
        release: null,
        progress: null,
        errorCode: this.state.forced ? "check-failed" : null,
      });
    }
    return this.getState();
  }

  install(): Promise<DesktopUpdateSnapshot> {
    if (this.downloadPromise) return this.downloadPromise;
    this.downloadPromise = this.installInternal().finally(() => {
      this.downloadPromise = null;
    });
    return this.downloadPromise;
  }

  defer(): DesktopUpdateSnapshot {
    if (this.state.forced) throw new Error("A required Desktop update cannot be deferred.");
    const release = this.state.release;
    if (!release) throw new Error("No Desktop update is available to defer.");
    this.store.save(release, "declined", this.serverOrigin(), this.now().toISOString());
    this.updateState({ phase: "deferred", progress: null, errorCode: null });
    return this.getState();
  }

  dispose(): void {
    this.disposed = true;
    if (this.automaticCheckTimer) {
      this.clearTimer(this.automaticCheckTimer);
      this.automaticCheckTimer = null;
    }
    this.downloadAbortController?.abort();
    this.downloadAbortController = null;
  }

  private scheduleAutomaticCheck(): void {
    const delay = this.options.automaticCheckDelayMs ?? DEFAULT_AUTOMATIC_CHECK_DELAY_MS;
    const elapsed = Math.max(0, this.options.uptimeMs?.() ?? process.uptime() * 1_000);
    const remaining = Math.max(0, delay - elapsed);
    this.automaticCheckTimer = this.setTimer(() => {
      this.automaticCheckTimer = null;
      void this.runAutomaticCheck();
    }, remaining);
  }

  private async runAutomaticCheck(): Promise<void> {
    await this.start();
    if (this.disposed || this.state.forced) return;
    try {
      await this.checkRelease();
    } catch (error) {
      this.log(`Automatic Desktop update check failed: ${errorMessage(error)}`);
      this.updateState({ phase: "ready", release: null, progress: null, errorCode: null });
    }
  }

  private async checkBackendCompatibility(): Promise<DesktopUpdateSnapshot> {
    this.updateState({ phase: "checking-health", errorCode: null });
    let serverOrigin: string;
    let serverVersion: string;
    try {
      serverOrigin = this.serverOrigin();
      const payload = await this.fetchJson<HealthPayload>(this.apiUrl("/health"));
      serverVersion = typeof payload.version === "string" ? payload.version.trim() : "";
      if (payload.status !== "ok" || !isNumericProductVersion(serverVersion)) {
        throw new Error("The health response did not include a valid backend version.");
      }
    } catch (error) {
      this.applyFailedHealthCheck(error);
      return this.getState();
    }

    const forced = compareProductVersions(serverVersion, this.options.currentVersion) > 0;
    try {
      if (forced) {
        this.store.saveKnownMinimum(serverOrigin, serverVersion, this.now().toISOString());
      } else {
        this.store.clearKnownMinimum(serverOrigin);
      }
    } catch (error) {
      this.log(`Desktop compatibility state could not be persisted: ${errorMessage(error)}`);
    }
    this.updateState({
      serverVersion,
      forced,
      phase: forced ? "force-required" : "ready",
      errorCode: null,
    });
    return this.getState();
  }

  private applyFailedHealthCheck(error: unknown): void {
    let serverOrigin: string;
    try {
      serverOrigin = this.serverOrigin();
    } catch {
      this.log(`Desktop compatibility health check failed open: ${errorMessage(error)}`);
      this.updateState({ serverVersion: null, phase: "ready", forced: false, errorCode: null });
      return;
    }

    const knownMinimum = this.store.getKnownMinimum(serverOrigin);
    if (
      knownMinimum &&
      compareProductVersions(knownMinimum.version, this.options.currentVersion) > 0
    ) {
      this.log(
        `Desktop compatibility health check failed; enforcing known minimum ${knownMinimum.version}: ${errorMessage(error)}`,
      );
      this.updateState({
        serverVersion: knownMinimum.version,
        phase: "force-required",
        forced: true,
        errorCode: null,
      });
      return;
    }

    if (knownMinimum) {
      try {
        this.store.clearKnownMinimum(serverOrigin);
      } catch (stateError) {
        this.log(`Satisfied Desktop compatibility state could not be cleared: ${errorMessage(stateError)}`);
      }
    }
    this.log(`Desktop compatibility health check failed open: ${errorMessage(error)}`);
    this.updateState({ serverVersion: null, phase: "ready", forced: false, errorCode: null });
  }

  private async checkRelease(): Promise<DesktopUpdateRelease | null> {
    this.updateState({ phase: "checking-update", progress: null, errorCode: null });
    const preferredTarget = desktopReleaseTarget(this.options.platform);
    let requestedTarget = preferredTarget;
    let payload: ReleasePayload;
    try {
      payload = await this.fetchReleasePayload(preferredTarget);
    } catch (error) {
      if (!(error instanceof HttpStatusError) || error.status !== 503 || preferredTarget === "desktop") {
        throw error;
      }
      requestedTarget = "desktop";
      payload = await this.fetchReleasePayload(requestedTarget);
    }
    const release = parseRelease(payload, this.options.currentVersionCode, requestedTarget);
    if (!release) {
      this.updateState({
        phase: this.state.forced ? "force-required" : "ready",
        release: null,
        progress: null,
        errorCode: this.state.forced ? "required-update-unavailable" : null,
      });
      return null;
    }
    if (
      this.state.forced &&
      this.state.serverVersion &&
      compareProductVersions(release.versionName, this.state.serverVersion) < 0
    ) {
      this.updateState({
        phase: "force-required",
        release: null,
        progress: null,
        errorCode: "required-update-unavailable",
      });
      return null;
    }
    this.downloadedInstallerPath = null;
    const storedDecision = this.store.get(
      this.serverOrigin(),
      release.versionCode,
      release.versionName,
    );
    const deferred = !this.state.forced &&
      storedDecision?.decision === "declined" &&
      storedDecision.serverOrigin === this.serverOrigin();
    this.updateState({
      phase: deferred ? "deferred" : "available",
      release,
      progress: null,
      errorCode: null,
    });
    return release;
  }

  private async fetchReleasePayload(target: DesktopReleaseTarget): Promise<ReleasePayload> {
    const url = new URL(this.apiUrl("/client-releases/check"));
    url.searchParams.set("platform", target);
    url.searchParams.set("versionCode", String(this.options.currentVersionCode));
    return this.fetchJson<ReleasePayload>(url.toString());
  }

  private async installInternal(): Promise<DesktopUpdateSnapshot> {
    await this.start();
    if (this.disposed || !this.supported) return this.getState();
    const release = this.state.release;
    if (!release) return this.getState();

    // Persist the user's acceptance before any network or filesystem work.
    this.store.save(release, "accepted", this.serverOrigin(), this.now().toISOString());
    try {
      if (!this.downloadedInstallerPath || !fs.existsSync(this.downloadedInstallerPath)) {
        this.downloadedInstallerPath = await this.downloadInstaller(release);
      }
      this.updateState({ phase: "opening-installer", progress: null, errorCode: null });
      const openError = await this.options.openPath(this.downloadedInstallerPath);
      if (openError) throw new DesktopUpdateError("open-failed", openError);
      this.updateState({ phase: "installer-opened", progress: null, errorCode: null });
    } catch (error) {
      const code = error instanceof DesktopUpdateError ? error.code : "download-failed";
      this.log(`Desktop update installation handoff failed: ${errorMessage(error)}`);
      this.updateState({
        phase: this.state.forced ? "force-required" : "available",
        progress: null,
        errorCode: code,
      });
    }
    return this.getState();
  }

  private async downloadInstaller(release: DesktopUpdateRelease): Promise<string> {
    const extension = this.options.platform === "darwin" ? "dmg" : "exe";
    const url = validateDownloadUrl(
      release.downloadUrl,
      extension,
      this.options.apiOrigin(),
      this.options.allowInsecureHttp === true,
    );
    const versionDirectory = path.join(this.options.downloadDirectory, String(release.versionCode));
    const safeVersion = release.versionName.replace(/[^0-9A-Za-z._-]+/g, "-");
    const destination = path.join(versionDirectory, `Agents-Anywhere-${safeVersion}.${extension}`);
    const partial = `${destination}.part`;
    fs.mkdirSync(versionDirectory, { recursive: true, mode: 0o700 });
    fs.rmSync(partial, { force: true });

    this.downloadAbortController = new AbortController();
    this.updateState({
      phase: "downloading",
      progress: { receivedBytes: 0, totalBytes: null, percent: null },
      errorCode: null,
    });
    let handle: fs.promises.FileHandle | null = null;
    try {
      const response = await this.options.fetcher(url.toString(), {
        method: "GET",
        headers: { accept: "application/octet-stream" },
        redirect: "follow",
        signal: this.downloadAbortController.signal,
      });
      if (response.status !== 200 || !response.body) {
        throw new DesktopUpdateError("download-failed", `HTTP ${response.status}`);
      }
      if (response.url) {
        validateDownloadUrl(
          response.url,
          extension,
          this.options.apiOrigin(),
          this.options.allowInsecureHttp === true,
        );
      }
      const totalBytes = positiveContentLength(response.headers.get("content-length"));
      const reader = response.body.getReader();
      handle = await fs.promises.open(partial, "w", 0o600);
      let receivedBytes = 0;
      let lastReportedPercent = -1;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        await writeChunk(handle, value);
        receivedBytes += value.byteLength;
        const percent = totalBytes ? Math.min(100, Math.floor((receivedBytes / totalBytes) * 100)) : null;
        if (percent === null || percent !== lastReportedPercent) {
          lastReportedPercent = percent ?? lastReportedPercent;
          this.updateState({
            progress: { receivedBytes, totalBytes, percent },
          });
        }
      }
      if (receivedBytes === 0 || (totalBytes !== null && receivedBytes !== totalBytes)) {
        throw new DesktopUpdateError("download-failed", "The Desktop installer download is incomplete.");
      }
      await handle.close();
      handle = null;
      fs.rmSync(destination, { force: true });
      await fs.promises.rename(partial, destination);
      return destination;
    } catch (error) {
      if (error instanceof DesktopUpdateError) throw error;
      throw new DesktopUpdateError("download-failed", errorMessage(error));
    } finally {
      await handle?.close().catch(() => undefined);
      fs.rmSync(partial, { force: true });
      this.downloadAbortController = null;
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeout = this.setTimer(
      () => controller.abort(),
      this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await this.options.fetcher(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new HttpStatusError(response.status);
      return await response.json() as T;
    } finally {
      this.clearTimer(timeout);
    }
  }

  private apiUrl(route: string): string {
    const origin = this.options.apiOrigin().trim().replace(/\/+$/, "");
    const namespace = normalizeNamespace(this.options.apiNamespace());
    return `${origin}${namespace}${route}`;
  }

  private serverOrigin(): string {
    return new URL(this.options.apiOrigin().trim()).origin;
  }

  private updateState(patch: Partial<DesktopUpdateSnapshot>): void {
    this.state = { ...this.state, ...patch };
    this.options.onState?.(this.getState());
  }

  private log(message: string): void {
    this.options.onLog?.(message);
  }
}

class DesktopUpdateError extends Error {
  constructor(readonly code: DesktopUpdateErrorCode, message: string) {
    super(message);
  }
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

function parseRelease(
  payload: ReleasePayload,
  currentVersionCode: number,
  requestedTarget: DesktopReleaseTarget,
): DesktopUpdateRelease | null {
  if (payload.platform !== requestedTarget || typeof payload.updateAvailable !== "boolean") {
    throw new Error("The Desktop release response did not match the requested platform.");
  }
  if (payload.updateAvailable !== true) return null;
  const versionCode = Number(payload.latestVersionCode);
  const versionName = typeof payload.latestVersionName === "string"
    ? payload.latestVersionName.trim()
    : "";
  const downloadUrl = typeof payload.downloadUrl === "string" ? payload.downloadUrl.trim() : "";
  if (
    !Number.isSafeInteger(versionCode) ||
    versionCode <= currentVersionCode ||
    !isNumericProductVersion(versionName) ||
    !downloadUrl
  ) {
    throw new Error("The Desktop release response is invalid.");
  }
  return { versionCode, versionName, downloadUrl };
}

function validateDownloadUrl(
  raw: string,
  extension: string,
  rawApiOrigin: string,
  allowInsecureHttp: boolean,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DesktopUpdateError("invalid-download", "The Desktop download URL is invalid.");
  }
  let apiOrigin: URL;
  try {
    apiOrigin = new URL(rawApiOrigin);
  } catch {
    throw new DesktopUpdateError("invalid-download", "The Desktop API origin is invalid.");
  }
  const allowedProtocol = url.protocol === "https:" ||
    (
      url.protocol === "http:" &&
      allowInsecureHttp &&
      apiOrigin.protocol === "http:" &&
      url.hostname === apiOrigin.hostname
    );
  if (
    !allowedProtocol ||
    url.username ||
    url.password ||
    !url.pathname.toLowerCase().endsWith(`.${extension}`)
  ) {
    throw new DesktopUpdateError("invalid-download", "The Desktop download URL is not trusted for this platform.");
  }
  return url;
}

function desktopReleaseTarget(platform: NodeJS.Platform): DesktopReleaseTarget {
  if (platform === "darwin") return "desktop-macos";
  if (platform === "win32") return "desktop-windows";
  return "desktop";
}

function positiveContentLength(value: string | null): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function writeChunk(handle: fs.promises.FileHandle, value: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const { bytesWritten } = await handle.write(
      value,
      offset,
      value.byteLength - offset,
      null,
    );
    if (bytesWritten < 1) throw new Error("The Desktop installer could not be written to disk.");
    offset += bytesWritten;
  }
}

function normalizeNamespace(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function cloneSnapshot(value: DesktopUpdateSnapshot): DesktopUpdateSnapshot {
  return {
    ...value,
    release: value.release ? { ...value.release } : null,
    progress: value.progress ? { ...value.progress } : null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
