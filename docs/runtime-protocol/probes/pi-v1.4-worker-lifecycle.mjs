import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime,
  SessionManager, SettingsManager, ModelRuntime,
} from "@earendil-works/pi-coding-agent";

async function environment(config) {
  const models = await ModelRuntime.create({
    authPath: join(config.agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(config.agentDir, "model-store.json"), allowModelNetwork: false,
  });
  let calls = 0;
  for (const method of ["stream", "streamSimple", "complete", "completeSimple"]) {
    if (typeof models[method] === "function") models[method] = () => {
      calls++; throw new Error("No model calls are allowed");
    };
  }
  const model = models.getModel("openai", "gpt-4o-mini");
  assert.ok(model);
  async function build(sessionManager, factories = [], discover = false) {
    const services = await createAgentSessionServices({
      cwd: config.cwd, agentDir: config.agentDir, modelRuntime: models,
      settingsManager: SettingsManager.create(config.cwd, config.agentDir, { projectTrusted: false }),
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => true },
      resourceLoaderOptions: { noExtensions: !discover, noSkills: true, noPromptTemplates: true,
        noContextFiles: true, noThemes: true, extensionFactories: factories },
    });
    assert.equal(services.diagnostics.filter(x => x.type === "error").length, 0);
    const result = await createAgentSessionFromServices({ services, sessionManager, model, thinkingLevel: "off" });
    assert.equal(result.extensionsResult.errors.length, 0);
    return { ...result, services, diagnostics: services.diagnostics };
  }
  return { build, model, calls: () => calls };
}

async function child(config) {
  const env = await environment(config);
  const seen = [];
  let shutdowns = 0;
  const runtime = await createAgentSessionRuntime(
    async ({ sessionManager }) => {
      const value = await env.build(sessionManager, [
        (pi) => pi.on("session_shutdown", () => { shutdowns++; }),
      ], true);
      await value.session.bindExtensions({ uiContext: { notify: (text) => seen.push(text) } });
      return value;
    }, { ...config, sessionManager: SessionManager.inMemory(config.cwd) },
  );
  process.send({ type: "ready", sessionId: runtime.session.sessionId });
  process.on("message", async (request) => {
    try {
      if (request.type === "query") {
        await runtime.session.prompt("/owner-probe");
        process.send({ type: "observed", sessionId: runtime.session.sessionId, owner: seen.at(-1) });
      } else if (request.type === "close") {
        await runtime.session.abort();
        await runtime.dispose();
        assert.equal(shutdowns, 1);
        assert.equal(env.calls(), 0);
        process.send({ type: "closed", shutdowns, modelRequests: env.calls() }, () => {
          process.disconnect();
          process.exit(0);
        });
      }
    } catch (error) {
      process.send({ type: "failed", message: error.message });
      process.exitCode = 1;
      process.disconnect();
    }
  });
}

if (process.argv[2] === "--child") {
  await child(JSON.parse(await readFile(process.argv[3], "utf8")));
} else {
  const root = await mkdtemp(join(process.cwd(), "lifecycle-fixtures-"));
  const config = { cwd: join(root, "project"), agentDir: join(root, "agent") };
  await mkdir(join(config.cwd, ".pi", "extensions"), { recursive: true });
  await mkdir(config.agentDir, { recursive: true });
  await writeFile(join(config.agentDir, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "probe-no-network" } }));
  await writeFile(join(config.cwd, ".pi", "extensions", "state.js"),
    "let owner;\nexport default function(pi) {\n" +
    "pi.on('session_start', (event, ctx) => { owner = ctx.sessionManager.getSessionId(); });\n" +
    "pi.registerCommand('owner-probe', { handler: async (args, ctx) => ctx.ui.notify(owner) });\n}\n");
  const env = await environment(config);

  // Negative control: top-level extension state is shared by SDKs in one process.
  const first = await env.build(SessionManager.inMemory(config.cwd), [], true);
  const second = await env.build(SessionManager.inMemory(config.cwd), [], true);
  const seenFirst = [], seenSecond = [];
  await first.session.bindExtensions({ uiContext: { notify: value => seenFirst.push(value) } });
  await second.session.bindExtensions({ uiContext: { notify: value => seenSecond.push(value) } });
  await first.session.prompt("/owner-probe");
  assert.equal(seenFirst.at(-1), second.session.sessionId);
  assert.notEqual(first.session.sessionId, second.session.sessionId);
  first.session.dispose();
  second.session.dispose();

  const configFile = join(root, "config.json");
  await writeFile(configFile, JSON.stringify(config));
  function launch() {
    const worker = fork(fileURLToPath(import.meta.url), ["--child", configFile], {
      cwd: config.cwd, env: { PATH: process.env.PATH, LANG: "C.UTF-8" }, silent: true,
    });
    let stderr = "";
    worker.stderr.on("data", data => { stderr = (stderr + data).slice(-2000); });
    const messages = [], waiters = [];
    worker.on("message", message => {
      const index = waiters.findIndex(x => x.type === message.type || message.type === "failed");
      if (index >= 0) {
        const waiter = waiters.splice(index, 1)[0];
        message.type === "failed" ? waiter.reject(new Error(message.message)) : waiter.resolve(message);
      } else messages.push(message);
    });
    const exited = once(worker, "exit");
    return {
      worker, exited,
      wait(type) {
        return new Promise((resolve, reject) => {
          const found = messages.findIndex(x => x.type === type || x.type === "failed");
          if (found >= 0) {
            const message = messages.splice(found, 1)[0];
            return message.type === "failed" ? reject(new Error(message.message)) : resolve(message);
          }
          const timer = setTimeout(() => reject(new Error("worker timed out: " + type + " " + stderr)), 10000);
          timer.unref();
          waiters.push({ type,
            resolve: value => { clearTimeout(timer); resolve(value); },
            reject: error => { clearTimeout(timer); reject(error); } });
        });
      },
    };
  }
  const workers = [launch(), launch()];
  let closed;
  try {
    const ready = await Promise.all(workers.map(x => x.wait("ready")));
    assert.notEqual(ready[0].sessionId, ready[1].sessionId);
    const observations = workers.map(x => x.wait("observed"));
    workers.forEach(x => x.worker.send({ type: "query" }));
    const observed = await Promise.all(observations);
    observed.forEach((value, i) => assert.equal(value.owner, ready[i].sessionId));
    const closing = workers.map(x => x.wait("closed"));
    workers.forEach(x => x.worker.send({ type: "close" }));
    closed = await Promise.all(closing);
    const exits = await Promise.all(workers.map(x => x.exited));
    exits.forEach(([code, signal]) => { assert.equal(code, 0); assert.equal(signal, null); });
  } finally {
    workers.forEach(x => { if (x.worker.exitCode === null && x.worker.signalCode === null) x.worker.kill("SIGKILL"); });
    await Promise.allSettled(workers.map(x => x.exited));
  }

  const sm = SessionManager.create(config.cwd, join(root, "sessions"));
  sm.appendModelChange(env.model.provider, env.model.id);
  sm.appendThinkingLevelChange("off");
  const selected = sm.appendMessage({ role: "user", content: "selected branch", timestamp: 1 });
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer" }],
    api: env.model.api, provider: env.model.provider, model: env.model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 2 });
  const tail = sm.appendMessage({ role: "user", content: "other branch", timestamp: 3 });
  const historyFile = sm.getSessionFile();
  sm.branch(selected);
  const position = { piSessionId: sm.getSessionId(), leafId: selected, positionRevision: 1 };
  const positionFile = join(root, "position.json");
  await writeFile(positionFile + ".pending", JSON.stringify(position));
  await rename(positionFile + ".pending", positionFile);
  const open = SessionManager.open(historyFile);
  assert.equal(open.getLeafId(), tail);
  const saved = JSON.parse(await readFile(positionFile, "utf8"));
  assert.equal(open.getSessionId(), saved.piSessionId);
  assert.ok(open.getEntry(saved.leafId));
  open.branch(saved.leafId);
  const restored = await env.build(open);
  assert.equal(restored.session.sessionManager.getLeafId(), selected);
  const restoredUsers = restored.session.sessionManager.buildSessionContext().messages.filter(x => x.role === "user");
  assert.deepEqual(restoredUsers.map(x => x.content), ["selected branch"]);
  restored.session.dispose();
  const atRoot = SessionManager.open(historyFile);
  atRoot.resetLeaf();
  assert.equal(atRoot.getLeafId(), null);
  assert.equal(atRoot.buildSessionContext().messages.length, 0);

  let rawShutdowns = 0;
  const raw = await env.build(SessionManager.inMemory(config.cwd), [
    (pi) => pi.on("session_shutdown", () => { rawShutdowns++; }),
  ]);
  await raw.session.bindExtensions({});
  raw.session.dispose();
  assert.equal(rawShutdowns, 0);
  let hooks = 0;
  const runtime = await createAgentSessionRuntime(
    async ({ sessionManager }) => {
      const value = await env.build(sessionManager, [(pi) => pi.on("session_shutdown", () => {
        hooks++;
        pi.appendEntry("shutdown-proof", { clean: true });
      })]);
      await value.session.bindExtensions({});
      return value;
    }, { ...config, sessionManager: open },
  );
  const leafBeforeShutdown = open.getLeafId();
  await runtime.session.abort();
  await runtime.dispose();
  const finalLeaf = open.getLeafId();
  assert.equal(hooks, 1);
  assert.notEqual(finalLeaf, leafBeforeShutdown);
  assert.equal(open.getEntry(finalLeaf).customType, "shutdown-proof");
  await writeFile(positionFile, JSON.stringify({ ...position, leafId: finalLeaf, positionRevision: 2 }));
  const finalSaved = JSON.parse(await readFile(positionFile, "utf8"));
  const finalOpen = SessionManager.open(historyFile);
  finalOpen.branch(finalSaved.leafId);
  assert.equal(finalOpen.getLeafId(), finalLeaf);
  assert.equal(env.calls(), 0);
  const output = {
    pi: "1.4.0", node: process.version, platform: process.platform, arch: process.arch,
    sameProcessStateShared: true,
    independentProcesses: { workers: 2, ownSessionObserved: true, shutdowns: closed.map(x => x.shutdowns), exitCodes: [0, 0] },
    position: { fileDefaultWasDifferent: true, savedBranchRestored: true, otherBranchExcluded: true, nullRootRestored: true },
    close: { rawDisposeShutdownHooks: rawShutdowns, shutdownHooks: hooks, shutdownMetadataIncludedInFinalPosition: true },
    modelRequests: env.calls() + closed.reduce((sum, x) => sum + x.modelRequests, 0),
  };
  await writeFile(join(process.cwd(), "worker-lifecycle-result.json"), JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify(output, null, 2));
  console.log("probeSha256=" + createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"));
}
