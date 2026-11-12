import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

// SDK mechanism probe only: the operation store, response endpoint and final
// HTTP transport below are in-memory fixtures, not platform implementations.
const root = await mkdtemp(join(process.cwd(), "initialization-selection-fixtures-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
await mkdir(agentDir, { recursive: true });
await mkdir(cwd, { recursive: true });
await writeFile(join(agentDir, "auth.json"), JSON.stringify({
  openai: { type: "api_key", key: "probe-no-network" },
}));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({
  retry: { enabled: false }, compaction: { enabled: false },
  providerRetry: { maxRetries: 0 }, cacheWarming: "off", transport: "sse",
}));
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"), modelsPath: null,
  modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false,
});
runtime.registerProvider("aa-selection-probe", {
  api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "probe-no-network",
  models: ["probe-a", "probe-b"].map(id => ({
    id, name: id, reasoning: true, input: ["text"], contextWindow: 4096, maxTokens: 64,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })),
});
const selected = runtime.getModel("aa-selection-probe", "probe-a");
const other = runtime.getModel("aa-selection-probe", "probe-b");
assert.ok(selected && other);
assert.equal(selected.api, "openai-completions");

const originalFetch = globalThis.fetch;
let externalFetchAttempts = 0;
globalThis.fetch = async () => {
  externalFetchAttempts++;
  throw new Error("External network is forbidden in this probe");
};

async function build(factories, modelRuntime = runtime) {
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  settings.applyOverrides({ cacheWarming: "off", transport: "sse" });
  const resources = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: factories,
  });
  await resources.reload();
  const result = await createAgentSession({
    cwd, agentDir, modelRuntime, model: selected, thinkingLevel: "off",
    resourceLoader: resources, settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd), noTools: "all",
  });
  assert.equal(result.extensionsResult.errors.length, 0);
  return result.session;
}

const startup = { phase: "initializing", generation: "worker-1", requests: [], receipts: new Map() };
const waiters = new Map();
function openDialog(kind, initialValue) {
  const interactionId = `startup-${startup.requests.length + 1}`;
  startup.phase = "awaiting_input";
  startup.requests.push({ interactionId, kind, initialValue, generation: startup.generation });
  return new Promise(resolve => waiters.set(interactionId, resolve));
}
function respond(id, generation, responseOperationId, value) {
  if (generation !== startup.generation) return "stale";
  if (startup.receipts.has(responseOperationId)) return startup.receipts.get(responseOperationId);
  const resolve = waiters.get(id);
  if (!resolve) return "not_pending";
  waiters.delete(id);
  startup.receipts.set(responseOperationId, "applied");
  resolve(value);
  return "applied";
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Probe did not reach the expected phase");
}

try {
  let initialized = false;
  const startupAnswers = [];
  const session = await build([pi => pi.on("session_start", async (_event, ctx) => {
    startupAnswers.push(await ctx.ui.confirm("Initialize", "Continue?"));
    startupAnswers.push(await ctx.ui.input("Initial value"));
    startupAnswers.push(await ctx.ui.editor("Startup editor", "  prefill\n"));
  })]);
  try {
    const binding = session.bindExtensions({ uiContext: {
      confirm: () => openDialog("confirm"),
      input: () => openDialog("input"),
      editor: (_title, prefill) => openDialog("editor", prefill),
    } }).then(() => { initialized = true; startup.phase = "ready"; });
    await until(() => startup.requests.length === 1);
    assert.equal(initialized, false);
    assert.equal(respond("startup-1", "worker-old", "answer-stale", true), "stale");
    assert.equal(respond("startup-1", "worker-1", "answer-1", true), "applied");
    assert.equal(respond("startup-1", "worker-1", "answer-1", true), "applied");
    await until(() => startup.requests.length === 2);
    assert.equal(respond("startup-2", "worker-1", "answer-2", ""), "applied");
    await until(() => startup.requests.length === 3);
    assert.equal(startup.requests[2].initialValue, "  prefill\n");
    assert.equal(respond("startup-3", "worker-1", "answer-3", "  first\nsecond\n"), "applied");
    await binding;
    assert.deepEqual(startupAnswers, [true, "", "  first\nsecond\n"]);
    assert.equal(startup.receipts.size, 3);
  } finally {
    for (const resolve of waiters.values()) resolve(undefined);
    session.dispose();
  }

  const observations = [];
  const wire = [];
  let rejectedAtRequest = 0;
  let rejectedAtPrepare = 0;
  let rejectedAtPayload = 0;
  let rejectedAtFetch = 0;
  let sdkIntakes = 0;
  let currentSession;
  function checkModel(model) {
    if (model.provider !== selected.provider || model.id !== selected.id) {
      throw new Error("pi_request_selection_changed");
    }
  }
  function checkSessionSelection() {
    checkModel(currentSession.model);
    if (currentSession.thinkingLevel !== "off") throw new Error("pi_request_effort_changed");
  }
  function checkPayload(payload) {
    if (!payload || typeof payload !== "object" || payload.model !== selected.id) {
      throw new Error("pi_request_payload_changed");
    }
    if (payload.reasoning_effort !== undefined && payload.reasoning_effort !== "none") {
      throw new Error("pi_request_effort_changed");
    }
  }
  // Preserve the original ModelRuntime as the receiver of its public methods.
  // This limited probe profile covers streamSimple and one physical HTTP API.
  const guarded = new Proxy(runtime, { get(target, key) {
    if (key === "streamSimple") return (model, context, options = {}) => {
      try { checkModel(model); checkSessionSelection(); }
      catch (error) { rejectedAtRequest++; throw error; }
      const previousOnPayload = options.onPayload;
      return target.streamSimple(model, context, {
        ...options, maxRetries: 0,
        onPayload: async (payload, requestModel) => {
          const transformed = await previousOnPayload?.(payload, requestModel);
          const finalPayload = transformed === undefined ? payload : transformed;
          try { checkSessionSelection(); checkPayload(finalPayload); }
          catch (error) { rejectedAtPayload++; throw error; }
          return finalPayload;
        },
        fetch: async (_url, init) => {
          const payload = JSON.parse(init.body);
          try { checkSessionSelection(); checkPayload(payload); }
          catch (error) { rejectedAtFetch++; throw error; }
          wire.push({ model: payload.model });
          const chunk = { id: "probe", object: "chat.completion.chunk", model: selected.id,
            choices: [{ index: 0, delta: { content: "probe response" }, finish_reason: "stop" }] };
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            status: 200, headers: { "content-type": "text/event-stream" },
          });
        },
      });
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });

  async function modelCase(name, factories, wrapPrepare = false) {
    const s = await build(factories, guarded);
    currentSession = s;
    const before = { wire: wire.length, request: rejectedAtRequest,
      prepare: rejectedAtPrepare, payload: rejectedAtPayload };
    try {
      await s.bindExtensions({});
      assert.equal(s.model.id, selected.id);
      if (wrapPrepare) {
        const prepare = s.agent.prepareRequest;
        s.agent.prepareRequest = async (request, signal) => {
          const prepared = await prepare?.(request, signal);
          try {
            checkSessionSelection();
            checkModel(prepared?.model ?? request.model);
          } catch (error) { rejectedAtPrepare++; throw error; }
          return prepared;
        };
      }
      await s.prompt("A local mechanism probe", { preflightResult(disposition) {
        if (disposition === "started") sdkIntakes++;
      } });
      const fact = { name, selectedBeforePrompt: selected.id, actualAfterPrompt: s.model.id,
        wire: wire.length - before.wire, requestRejected: rejectedAtRequest - before.request,
        prepareRejected: rejectedAtPrepare - before.prepare,
        payloadRejected: rejectedAtPayload - before.payload };
      observations.push(fact);
      return fact;
    } finally { await s.abort(); s.dispose(); currentSession = undefined; }
  }
  const changedModel = pi => pi.on("before_agent_start", async () => {
    assert.equal(await pi.setModel(other), true);
  });
  const rawBoundary = await modelCase("late-model-at-runtime", [changedModel]);
  assert.equal(rawBoundary.requestRejected, 1);
  assert.equal(rawBoundary.wire, 0);
  const preparedBoundary = await modelCase("late-model-at-prepareRequest", [changedModel], true);
  assert.equal(preparedBoundary.prepareRejected, 1);
  assert.equal(preparedBoundary.wire, 0);
  const changedEffort = await modelCase("late-effort-at-runtime", [pi => {
    pi.on("before_agent_start", () => pi.setThinkingLevel("high"));
  }]);
  assert.equal(changedEffort.requestRejected, 1);
  assert.equal(changedEffort.wire, 0);
  const changedPayload = await modelCase("late-payload-mutation", [pi => {
    pi.on("before_provider_request", event => ({ ...event.payload, model: other.id }));
  }]);
  assert.equal(changedPayload.payloadRejected, 1);
  assert.equal(changedPayload.wire, 0);
  const changedPayloadEffort = await modelCase("late-payload-effort", [pi => {
    pi.on("before_provider_request", event => ({ ...event.payload, reasoning_effort: "high" }));
  }]);
  assert.equal(changedPayloadEffort.payloadRejected, 1);
  assert.equal(changedPayloadEffort.wire, 0);
  const unchanged = await modelCase("unchanged-selection", []);
  assert.equal(unchanged.wire, 1);
  assert.equal(wire[0].model, selected.id);
  assert.equal(sdkIntakes, 6);
  assert.equal(rejectedAtFetch, 0);
  assert.equal(externalFetchAttempts, 0);
  console.log(JSON.stringify({
    pi: "1.4.0", node: process.version, platform: process.platform, arch: process.arch,
    startup: { phase: startup.phase, answers: startupAnswers, staleRejected: true, uniqueResponses: 3 },
    observations, sdkIntakes, mockProviderRequests: wire.length, externalFetchAttempts,
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
}
