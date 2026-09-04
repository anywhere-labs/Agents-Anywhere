import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopUpdateService } from "./desktop-update-service";
import type { DesktopUpdateSnapshot } from "./desktop-update-types";

test("backend-ahead health gates the app until a checked installer is accepted", async () => {
  const harness = createHarness({ serverVersion: "0.1.7.3" });
  try {
    const startup = await harness.service.start();
    assert.equal(startup.phase, "force-required");
    assert.equal(startup.forced, true);
    assert.equal(harness.requests.filter((url) => url.includes("client-releases/check")).length, 0);
    assert.equal((await harness.service.install()).phase, "force-required");
    assert.equal(harness.downloadRequests, 0, "install cannot bypass the explicit release check");

    const checked = await harness.service.checkNow();
    assert.equal(checked.phase, "available");
    assert.equal(checked.release?.versionName, "0.1.7.3");
    assert.equal(harness.downloadRequests, 0, "checking does not download the installer");

    const installed = await harness.service.install();
    assert.equal(installed.phase, "installer-opened");
    assert.equal(harness.downloadRequests, 1);
    assert.equal(harness.openedPaths.length, 1);
    assert.match(harness.openedPaths[0], /Agents-Anywhere-0\.1\.7\.3\.dmg$/);
    assert.deepEqual(fs.readFileSync(harness.openedPaths[0]), Buffer.from("desktop-installer"));
    assert.ok(harness.states.some((state) => state.phase === "downloading"));
    assert.ok(harness.states.some((state) => state.progress?.percent === 100));

    const persisted = JSON.parse(fs.readFileSync(harness.statePath, "utf8")) as {
      decisions: Array<Record<string, unknown>>;
      knownMinimumVersions: Array<Record<string, unknown>>;
    };
    assert.equal(persisted.decisions[0]?.decision, "accepted");
    assert.equal(persisted.decisions[0]?.serverOrigin, "https://server.example");
    assert.equal(persisted.knownMinimumVersions[0]?.version, "0.1.7.3");
  } finally {
    harness.cleanup();
  }
});

test("health failures fail open without performing the delayed release check", async () => {
  const harness = createHarness({ healthFailure: true });
  try {
    const startup = await harness.service.start();
    assert.equal(startup.phase, "ready");
    assert.equal(startup.forced, false);
    assert.equal(harness.requests.length, 1);
    assert.match(harness.logs[0], /failed open/);
  } finally {
    harness.cleanup();
  }
});

test("a remembered backend minimum keeps an offline older client gated", async () => {
  const online = createHarness({ serverVersion: "0.1.7.3", preserveRoot: true });
  const root = online.root;
  try {
    assert.equal((await online.service.start()).forced, true);
    online.service.dispose();

    const offline = createHarness({ root, healthFailure: true });
    try {
      const startup = await offline.service.start();
      assert.equal(startup.phase, "force-required");
      assert.equal(startup.forced, true);
      assert.equal(startup.serverVersion, "0.1.7.3");
      assert.match(offline.logs[0], /enforcing known minimum/);
    } finally {
      offline.cleanup();
    }

    const otherBackend = createHarness({
      root,
      serverOrigin: "https://other.example",
      healthFailure: true,
    });
    try {
      assert.equal((await otherBackend.service.start()).forced, false);
    } finally {
      otherBackend.cleanup();
    }
  } finally {
    online.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a confirmed compatible backend clears its remembered minimum", async () => {
  const ahead = createHarness({ serverVersion: "0.1.7.3", preserveRoot: true });
  const root = ahead.root;
  try {
    assert.equal((await ahead.service.start()).forced, true);
    ahead.service.dispose();

    const compatible = createHarness({ root, serverVersion: "0.1.7.2" });
    try {
      assert.equal((await compatible.service.start()).forced, false);
    } finally {
      compatible.cleanup();
    }

    const offline = createHarness({ root, healthFailure: true });
    try {
      assert.equal((await offline.service.start()).forced, false);
    } finally {
      offline.cleanup();
    }
  } finally {
    ahead.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an upgraded client clears a satisfied minimum even while health is offline", async () => {
  const older = createHarness({ serverVersion: "0.1.7.3", preserveRoot: true });
  const root = older.root;
  try {
    assert.equal((await older.service.start()).forced, true);
    older.service.dispose();

    const upgraded = createHarness({
      root,
      currentVersion: "0.1.7.3",
      currentVersionCode: 7,
      healthFailure: true,
    });
    try {
      assert.equal((await upgraded.service.start()).forced, false);
    } finally {
      upgraded.cleanup();
    }

    const stillOlder = createHarness({ root, healthFailure: true });
    try {
      assert.equal((await stillOlder.service.start()).forced, false);
    } finally {
      stillOlder.cleanup();
    }
  } finally {
    older.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a declined release is silent only for the same backend and exact release", async () => {
  const first = createHarness();
  try {
    await first.service.start();
    assert.equal((await first.service.checkNow()).phase, "available");
    assert.equal(first.service.defer().phase, "deferred");

    const same = createHarness({ root: first.root, preserveRoot: true });
    try {
      await same.service.start();
      assert.equal((await same.service.checkNow()).phase, "deferred");
    } finally {
      same.cleanup();
    }

    const otherBackend = createHarness({
      root: first.root,
      preserveRoot: true,
      serverOrigin: "https://other.example",
    });
    try {
      await otherBackend.service.start();
      assert.equal((await otherBackend.service.checkNow()).phase, "available");
    } finally {
      otherBackend.cleanup();
    }

    const originalBackendAgain = createHarness({ root: first.root, preserveRoot: true });
    try {
      await originalBackendAgain.service.start();
      assert.equal(
        (await originalBackendAgain.service.checkNow()).phase,
        "deferred",
        "switching back restores the original backend's exact decline",
      );
    } finally {
      originalBackendAgain.cleanup();
    }

    const newerRelease = createHarness({
      root: first.root,
      preserveRoot: true,
      releaseVersionCode: 8,
      releaseVersionName: "0.1.7.4",
    });
    try {
      await newerRelease.service.start();
      assert.equal((await newerRelease.service.checkNow()).phase, "available");
    } finally {
      newerRelease.cleanup();
    }
  } finally {
    first.cleanup();
  }
});

test("forced update checks retain the gate and expose retry errors", async () => {
  const harness = createHarness({
    serverVersion: "0.1.7.3",
    releaseFailure: true,
  });
  try {
    await harness.service.start();
    const state = await harness.service.checkNow();
    assert.equal(state.forced, true);
    assert.equal(state.phase, "force-required");
    assert.equal(state.errorCode, "check-failed");
  } finally {
    harness.cleanup();
  }
});

test("installer type is enforced before downloading or opening", async () => {
  const harness = createHarness({ downloadUrl: "https://downloads.example/app.exe" });
  try {
    await harness.service.start();
    await harness.service.checkNow();
    const state = await harness.service.install();
    assert.equal(state.phase, "available");
    assert.equal(state.errorCode, "invalid-download");
    assert.equal(harness.downloadRequests, 0);
    assert.equal(harness.openedPaths.length, 0);
  } finally {
    harness.cleanup();
  }
});

test("HTTP downloads stay on the self-hosted API hostname", async () => {
  const rejected = createHarness({
    downloadUrl: "http://downloads.example/app.dmg",
    serverOrigin: "http://server.example:8000",
    allowInsecureHttp: true,
  });
  try {
    await rejected.service.start();
    await rejected.service.checkNow();
    assert.equal((await rejected.service.install()).errorCode, "invalid-download");
  } finally {
    rejected.cleanup();
  }

  const sameHost = createHarness({
    serverOrigin: "http://server.example:8000",
    downloadUrl: "http://server.example:8765/app.dmg",
    allowInsecureHttp: true,
  });
  try {
    await sameHost.service.start();
    await sameHost.service.checkNow();
    assert.equal((await sameHost.service.install()).phase, "installer-opened");
  } finally {
    sameHost.cleanup();
  }

  const downgrade = createHarness({
    serverOrigin: "https://server.example",
    downloadUrl: "http://server.example:8765/app.dmg",
    allowInsecureHttp: true,
  });
  try {
    await downgrade.service.start();
    await downgrade.service.checkNow();
    assert.equal((await downgrade.service.install()).errorCode, "invalid-download");
  } finally {
    downgrade.cleanup();
  }
  const packagedDefault = createHarness({
    serverOrigin: "http://server.example:8000",
    downloadUrl: "http://server.example:8765/app.dmg",
  });
  try {
    await packagedDefault.service.start();
    await packagedDefault.service.checkNow();
    assert.equal((await packagedDefault.service.install()).errorCode, "invalid-download");
  } finally {
    packagedDefault.cleanup();
  }
});

test("a redirected HTTP download is revalidated before writing", async () => {
  const harness = createHarness({
    serverOrigin: "http://server.example:8000",
    downloadUrl: "http://server.example:8765/app.dmg",
    finalDownloadUrl: "http://other.example/app.dmg",
    allowInsecureHttp: true,
  });
  try {
    await harness.service.start();
    await harness.service.checkNow();
    const state = await harness.service.install();
    assert.equal(state.errorCode, "invalid-download");
    assert.equal(harness.openedPaths.length, 0);
  } finally {
    harness.cleanup();
  }
});

test("an incomplete installer is discarded", async () => {
  const harness = createHarness({ contentLength: 100 });
  try {
    await harness.service.start();
    await harness.service.checkNow();
    const state = await harness.service.install();
    assert.equal(state.errorCode, "download-failed");
    assert.equal(harness.openedPaths.length, 0);
    assert.equal(
      fs.existsSync(path.join(harness.root, "downloads", "7", "Agents-Anywhere-0.1.7.3.dmg.part")),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test("partial HTTP responses are rejected instead of treated as complete installers", async () => {
  const harness = createHarness({ downloadStatus: 206 });
  try {
    await harness.service.start();
    await harness.service.checkNow();
    const state = await harness.service.install();
    assert.equal(state.errorCode, "download-failed");
    assert.equal(harness.openedPaths.length, 0);
  } finally {
    harness.cleanup();
  }
});

test("platform-specific release lookup falls back to the legacy desktop target on 503", async () => {
  const harness = createHarness({ primaryReleaseUnavailable: true });
  try {
    await harness.service.start();
    const state = await harness.service.checkNow();
    assert.equal(state.phase, "available");
    const targets = harness.requests
      .filter((url) => url.includes("client-releases/check"))
      .map((url) => new URL(url).searchParams.get("platform"));
    assert.deepEqual(targets, ["desktop-macos", "desktop"]);
  } finally {
    harness.cleanup();
  }
});

test("Windows requests its own target and only opens an exe", async () => {
  const harness = createHarness({
    platform: "win32",
    downloadUrl: "https://downloads.example/app.exe",
  });
  try {
    await harness.service.start();
    await harness.service.checkNow();
    assert.equal((await harness.service.install()).phase, "installer-opened");
    assert.match(harness.openedPaths[0], /\.exe$/);
    const checkUrl = harness.requests.find((url) => url.includes("client-releases/check"));
    assert.equal(new URL(checkUrl ?? "").searchParams.get("platform"), "desktop-windows");
  } finally {
    harness.cleanup();
  }
});

test("the automatic check delay is measured from process uptime", async () => {
  const delays: number[] = [];
  const fakeSetTimer = ((
    _callback: (...args: unknown[]) => void,
    delay?: number,
  ) => {
    delays.push(delay ?? 0);
    return { fake: true } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const fakeClearTimer = (() => undefined) as typeof clearTimeout;
  const harness = createHarness({
    automaticCheckDelayMs: 60_000,
    uptimeMs: () => 12_500,
    setTimer: fakeSetTimer,
    clearTimer: fakeClearTimer,
  });
  try {
    await harness.service.start();
    assert.equal(delays[0], 47_500);
  } finally {
    harness.cleanup();
  }
});

type HarnessOptions = {
  root?: string;
  preserveRoot?: boolean;
  serverOrigin?: string;
  serverVersion?: string;
  healthFailure?: boolean;
  releaseFailure?: boolean;
  releaseVersionCode?: number;
  releaseVersionName?: string;
  downloadUrl?: string;
  platform?: NodeJS.Platform;
  primaryReleaseUnavailable?: boolean;
  automaticCheckDelayMs?: number;
  finalDownloadUrl?: string;
  contentLength?: number;
  downloadStatus?: number;
  allowInsecureHttp?: boolean;
  currentVersion?: string;
  currentVersionCode?: number;
  uptimeMs?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
};

function createHarness(options: HarnessOptions = {}) {
  const ownsRoot = !options.root;
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-update-service-"));
  const serverOrigin = options.serverOrigin ?? "https://server.example";
  const statePath = path.join(root, "decision.json");
  const downloadDirectory = path.join(root, "downloads");
  const requests: string[] = [];
  const states: DesktopUpdateSnapshot[] = [];
  const logs: string[] = [];
  const openedPaths: string[] = [];
  let downloadRequests = 0;
  const platform = options.platform ?? "darwin";
  const releaseVersionCode = options.releaseVersionCode ?? 7;
  const releaseVersionName = options.releaseVersionName ?? "0.1.7.3";
  const downloadUrl = options.downloadUrl ?? "https://downloads.example/app.dmg";

  const service = new DesktopUpdateService({
    currentVersion: options.currentVersion ?? "0.1.7.2",
    currentVersionCode: options.currentVersionCode ?? 6,
    platform,
    apiOrigin: () => serverOrigin,
    apiNamespace: () => "/api/v2",
    statePath,
    downloadDirectory,
    automaticCheckDelayMs: options.automaticCheckDelayMs ?? 86_400_000,
    uptimeMs: options.uptimeMs ?? (() => 0),
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    allowInsecureHttp: options.allowInsecureHttp,
    fetcher: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === `${serverOrigin}/api/v2/health`) {
        if (options.healthFailure) throw new Error("health unavailable");
        return Response.json({ status: "ok", version: options.serverVersion ?? "0.1.7.2" });
      }
      if (url.startsWith(`${serverOrigin}/api/v2/client-releases/check?`)) {
        const requestedTarget = new URL(url).searchParams.get("platform");
        if (options.primaryReleaseUnavailable && requestedTarget !== "desktop") {
          return Response.json({ detail: "release unavailable" }, { status: 503 });
        }
        if (options.releaseFailure) throw new Error("release unavailable");
        return Response.json({
          platform: requestedTarget,
          updateAvailable: true,
          latestVersionCode: releaseVersionCode,
          latestVersionName: releaseVersionName,
          downloadUrl,
        });
      }
      if (url === downloadUrl) {
        downloadRequests += 1;
        const stored = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
          decisions?: Array<Record<string, unknown>>;
        };
        assert.equal(
          stored.decisions?.find((entry) => entry.serverOrigin === new URL(serverOrigin).origin)?.decision,
          "accepted",
          "acceptance is stored before network download",
        );
        const body = Buffer.from("desktop-installer");
        const response = new Response(body, {
          status: options.downloadStatus ?? 200,
          headers: { "content-length": String(options.contentLength ?? body.byteLength) },
        });
        if (options.finalDownloadUrl) {
          Object.defineProperty(response, "url", { value: options.finalDownloadUrl });
        }
        return response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    openPath: async (filePath) => {
      openedPaths.push(filePath);
      return "";
    },
    onState: (state) => states.push(state),
    onLog: (message) => logs.push(message),
  });

  return {
    root,
    statePath,
    service,
    requests,
    states,
    logs,
    openedPaths,
    get downloadRequests() {
      return downloadRequests;
    },
    cleanup: () => {
      service.dispose();
      if (ownsRoot && !options.preserveRoot) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
