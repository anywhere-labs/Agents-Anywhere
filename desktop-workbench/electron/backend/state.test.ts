import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { BackendInit } from "./protocol";
import { BackendState } from "./state";

function backendInit(root: string): BackendInit {
  return {
    dataPath: path.join(root, "connector"),
    logsPath: path.join(root, "logs"),
    settingsPath: path.join(root, "desktop-settings.json"),
    bindingPath: path.join(root, "connector", "desktop-binding.json"),
    configPath: path.join(root, "connector", "connector.json"),
    connectorDir: path.join(root, "source"),
    resourcesPath: root,
    uvBundleDir: root,
    pythonBundleDir: root,
    homePath: root,
    documentsPath: root,
    packaged: false,
    preferredLanguages: ["en-US"],
    defaultServerUrl: "https://api.example.test",
    apiNamespace: "/api/v2",
    desktopExecutablePath: process.execPath,
    desktopAppPath: root,
  };
}

/** A backend whose startup steps are recorded; the ownership probe stays open until released. */
function startup(t: TestContext, recordInstallation: () => Promise<void> = async () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-backend-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const steps: string[] = [];
  let releaseProbe!: () => void;
  let probeStarted!: () => void;
  const probing = new Promise<void>(resolve => { probeStarted = resolve; });
  const logs: Array<{ level?: string; message?: string }> = [];
  const state = new BackendState(backendInit(root), fetch, undefined, async () => {
    steps.push("shell");
    return { PATH: "/usr/bin" };
  });
  Object.assign(state, {
    machineState: {
      recordInstallation: async () => { steps.push("record"); await recordInstallation(); },
    },
    logs: { append: (entry: { level?: string; message?: string }) => { logs.push(entry); return entry; } },
    connector: {
      setShellEnvironment: () => {},
      acquireOwnership: () => new Promise<void>(resolve => {
        steps.push("probe");
        releaseProbe = resolve;
        probeStarted();
      }),
      loadPrivateConfig: () => null,
      bindingChanged: () => {},
      hasRuntimeLogs: () => true,
    },
  });
  return { state, steps, logs, probing, releaseProbe: () => releaseProbe() };
}

test("the installation is published before the ownership probe waits for the Connector environment", async t => {
  const backend = startup(t);
  const initialized = backend.state.initialize();
  await backend.probing;
  assert.deepEqual(backend.steps, ["record", "shell", "probe"], "the DSH plugin must be able to find Desktop while the probe is still waiting");
  backend.releaseProbe();
  await initialized;
  assert.deepEqual(backend.steps, ["record", "shell", "probe"], "a published installation is not written twice");
  assert.deepEqual(backend.logs, []);
});

test("an installation the first attempt could not publish is retried after the probe", async t => {
  let attempts = 0;
  const backend = startup(t, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("Unsupported local Connector record version.");
  });
  const initialized = backend.state.initialize();
  await backend.probing;
  assert.deepEqual(backend.logs, [], "the probe may still repair the record, so the first failure is not reported");
  backend.releaseProbe();
  await initialized;
  assert.deepEqual(backend.steps, ["record", "shell", "probe", "record"]);
  assert.deepEqual(backend.logs, []);
});

test("an installation that still cannot be published after the probe is reported", async t => {
  const backend = startup(t, async () => { throw new Error("The local machine record is busy. Please retry."); });
  const initialized = backend.state.initialize();
  await backend.probing;
  backend.releaseProbe();
  await initialized;
  assert.equal(backend.logs.length, 1);
  assert.equal(backend.logs[0]?.level, "ERROR");
  assert.match(backend.logs[0]?.message ?? "", /Could not record Desktop installation: The local machine record is busy/);
});
