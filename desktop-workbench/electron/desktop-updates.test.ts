import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopUpdateService } from "./desktop-updates";
import { compareUpdateVersions } from "./update-version";
import type { DesktopUpdateState } from "../shared/desktop-updates";

const server = { serverUrl: "https://server.test", apiNamespace: "/api/v2", oauthWebOrigin: "https://server.test" };
const healthy = (version = "0.1.7.2") => Response.json({ status: "ok", version, downloadUrl: "https://untrusted.test/ignored.exe" });

function harness(t: TestContext, overrides: Partial<ConstructorParameters<typeof DesktopUpdateService>[0]> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aa-update-"));
  const states: DesktopUpdateState[] = [];
  const opened: string[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let version = "0.1.7.2";
  const options: ConstructorParameters<typeof DesktopUpdateService>[0] = {
    directory, currentVersion: "0.1.0", downloadUrl: "https://download.test/desktop", platform: "darwin",
    fetcher: async (input, init) => {
      requests.push({ url: String(input), init });
      return String(input).endsWith("/health") ? healthy(version) : new Response("installer", { headers: { "content-length": "9", "content-type": "application/octet-stream" } });
    },
    openInstaller: async (file) => { opened.push(file); },
    onState: (state) => states.push(state),
    ...overrides,
  };
  const services: DesktopUpdateService[] = [];
  const make = (patch = {}) => { const service = new DesktopUpdateService({ ...options, ...patch }); services.push(service); return service; };
  t.after(() => { services.forEach((service) => service.dispose()); fs.rmSync(directory, { recursive: true, force: true }); });
  return { service: make(), make, directory, states, opened, requests, setVersion: (next: string) => { version = next; } };
}

test("version comparison handles numeric segments, four-part releases and prereleases", () => {
  for (const [left, right, expected] of [
    ["0.1.10", "0.1.9", 1], ["0.1.7.2", "0.1.7", 1], ["v1.2.0+build", "1.2", 0],
    ["1.0.0-rc.2", "1.0.0-rc.10", -1], ["1.0.0-rc.1", "1.0.0", -1],
    ["1.0.0", "1.0.0rc1", 1], ["0.1.0", "0.1.7.2", -1], ["invalid", "0.1.0", null],
  ] as const) assert.equal(compareUpdateVersions(left, right), expected);
});

test("startup checks only health; ignored versions survive restart and newer versions prompt again", async (t) => {
  const h = harness(t);
  const available = await h.service.check(server);
  assert.equal(available.available, true);
  assert.equal(available.dialogOpen, true);
  assert.deepEqual(h.requests.map((r) => r.url), ["https://server.test/api/v2/health"]);
  assert.equal(h.requests[0].init?.credentials, "omit");
  h.service.ignoreVersion();
  assert.equal(h.service.getState().available, true, "the manual entry remains visible");
  assert.equal(h.service.getState().dialogOpen, false);
  const restarted = h.make();
  const ignored = await restarted.check(server);
  assert.equal(ignored.ignored, true);
  assert.equal(ignored.dialogOpen, false);
  assert.equal(restarted.showPrompt().dialogOpen, true, "manual entry bypasses the ignored preference");
  restarted.ignoreVersion();
  h.setVersion("0.1.8");
  assert.equal((await h.make().check(server)).dialogOpen, true);
  const upToDate = await h.make({ currentVersion: "0.1.8" }).check(server);
  assert.equal(upToDate.available, false);
  assert.equal(upToDate.dialogOpen, false);
  assert.ok(h.states.every((state) => !JSON.stringify(state).includes("token")));
});

test("ignoring a version on one server does not hide updates on another server", async (t) => {
  const h = harness(t);
  await h.service.check(server);
  h.service.ignoreVersion();
  assert.equal((await h.service.check({ ...server, serverUrl: "https://other.test" })).dialogOpen, true);
});

test("missing or invalid health versions never create a false update", async (t) => {
  for (const payload of [{ status: "ok" }, { status: "error", version: "99.0" }, { status: "ok", version: "latest" }]) {
    const h = harness(t, { fetcher: async () => Response.json(payload) });
    const state = await h.service.check(server);
    assert.equal(state.available, false);
    assert.equal(state.dialogOpen, false);
    assert.equal(state.error, "checkFailed");
  }
});

test("the config download URL is used, progress is published, and only a complete file is opened", async (t) => {
  const h = harness(t);
  await h.service.check(server);
  const download = h.service.download();
  assert.equal(h.service.download(), download, "double clicking does not download twice");
  const state = await download;
  assert.equal(state.phase, "downloaded");
  assert.equal(state.dialogOpen, false);
  assert.equal(state.available, true, "downloading alone must not claim the installed version changed");
  assert.equal(h.opened.length, 1);
  assert.equal(fs.readFileSync(h.opened[0], "utf8"), "installer");
  assert.equal(path.extname(h.opened[0]), ".dmg");
  assert.equal(h.requests[1].url, "https://download.test/desktop");
  assert.equal(h.requests[1].init?.credentials, "omit");
  assert.ok(h.states.some((s) => s.downloadedBytes === 9 && s.totalBytes === 9));
  assert.ok(h.states.every((s, index) => !index || s.revision > h.states[index - 1].revision));
});

test("partial downloads are removed and can be retried without closing the dialog", async (t) => {
  let fail = true;
  const h = harness(t, { fetcher: async (input) => String(input).endsWith("/health") ? healthy() : new Response("installer", { headers: { "content-length": fail ? "100" : "9", "content-type": "application/octet-stream" } }) });
  await h.service.check(server);
  assert.equal((await h.service.download()).error, "downloadFailed");
  assert.equal(h.service.getState().dialogOpen, true);
  assert.deepEqual(fs.readdirSync(path.join(h.directory, "downloads")), []);
  assert.equal(h.opened.length, 0);
  fail = false;
  assert.equal((await h.service.download()).phase, "downloaded");
});

test("HTML download responses and placeholder URLs are not opened as installers", async (t) => {
  const placeholder = harness(t, { downloadUrl: "https://downloads.example.invalid/desktop" });
  await placeholder.service.check(server);
  assert.equal((await placeholder.service.download()).error, "downloadNotConfigured");
  assert.equal(placeholder.requests.length, 1);
  const html = harness(t, { fetcher: async (input) => String(input).endsWith("/health") ? healthy() : new Response("<html>not an installer</html>", { headers: { "content-type": "text/html" } }) });
  await html.service.check(server);
  assert.equal((await html.service.download()).error, "downloadFailed");
  assert.equal(html.opened.length, 0);
});

test("a failed installer launch retries the existing complete download", async (t) => {
  let calls = 0;
  const h = harness(t, { openInstaller: async () => { if (++calls === 1) throw new Error("no handler"); } });
  await h.service.check(server);
  assert.equal((await h.service.download()).error, "openFailed");
  assert.equal((await h.service.download()).phase, "downloaded");
  assert.equal(h.requests.filter((r) => !r.url.endsWith("/health")).length, 1);
});

test("a late response from a previous server cannot overwrite the active server", async (t) => {
  let finish!: (response: Response) => void;
  const h = harness(t, { fetcher: async (input) => String(input).startsWith(server.serverUrl) ? new Promise((resolve) => { finish = resolve; }) : healthy("0.1.0") });
  const old = h.service.check(server);
  await h.service.check({ ...server, serverUrl: "https://other.test" });
  finish(healthy("99.0.0"));
  await old;
  assert.equal(h.service.getState().latestVersion, "0.1.0");
  assert.equal(h.service.getState().available, false);
});

test("unknown download sizes publish received bytes and finish at the actual size", async (t) => {
  const h = harness(t, { fetcher: async (input) => String(input).endsWith("/health") ? healthy() : new Response(new Uint8Array([1, 2, 3])) });
  await h.service.check(server);
  const result = await h.service.download();
  assert.ok(h.states.some((s) => s.phase === "downloading" && s.totalBytes === null));
  assert.equal(result.downloadedBytes, 3);
  assert.equal(result.totalBytes, 3);
});

test("quit cancels a stalled body, cleans partial files and never launches the installer", async (t) => {
  let cancelled = false;
  let downloading!: () => void;
  const started = new Promise<void>((resolve) => { downloading = resolve; });
  const h = harness(t, {
    fetcher: async (input) => String(input).endsWith("/health") ? healthy() : new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled = true; },
    })),
    onState: (s) => { if (s.downloadedBytes) downloading(); },
  });
  await h.service.check(server);
  const download = h.service.download();
  await started;
  h.service.dispose();
  await download;
  assert.equal(cancelled, true);
  assert.equal(h.opened.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(h.directory, "downloads")), []);
});

test("a stalled health response times out without blocking startup", async (t) => {
  let cancelled = false;
  const h = harness(t, {
    healthTimeoutMs: 10,
    fetcher: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })),
  });
  assert.equal((await h.service.check(server)).error, "checkFailed");
  assert.equal(h.service.getState().dialogOpen, false);
  assert.equal(cancelled, true);
});

test("failed preference writes leave the update dialog open for retry", async (t) => {
  const h = harness(t);
  await h.service.check(server);
  fs.mkdirSync(path.join(h.directory, "state.json"));
  assert.equal(h.service.ignoreVersion().error, "ignoreFailed");
  assert.equal(h.service.getState().dialogOpen, true);
  assert.equal(h.service.getState().ignored, false);
});
