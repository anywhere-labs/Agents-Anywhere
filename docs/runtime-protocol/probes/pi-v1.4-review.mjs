import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { runToolCall } from "@earendil-works/pi-agent-core";
import {
  createAgentSession, createAgentSessionServices, createAgentSessionFromServices,
  DefaultResourceLoader, SettingsManager, SessionManager,
  ProjectTrustStore, hasTrustRequiringProjectResources, ModelRuntime,
} from "@earendil-works/pi-coding-agent";

const root = await mkdtemp(join(process.cwd(), "fixtures-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
await mkdir(agentDir, { recursive: true });
await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "probe-no-network" } }));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o-mini" }));
const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false,
  modelsStorePath: join(agentDir, "models-store.json"),
});
let modelRequests = 0;
for (const method of ["stream", "streamSimple", "complete", "completeSimple"]) {
  if (typeof modelRuntime[method] !== "function") continue;
  modelRuntime[method] = () => {
    modelRequests++;
    throw new Error("This research probe must not call a model");
  };
}
const model = modelRuntime.getModel("openai", "gpt-4o-mini");
assert.ok(model);

const marker = join(root, "extension-executed");
await writeFile(join(cwd, ".pi", "extensions", "marker.js"),
  'import { appendFileSync } from "node:fs";\nexport default function () { appendFileSync(' + JSON.stringify(marker) + ', "loaded\\n"); }\n');
assert.equal(hasTrustRequiringProjectResources(cwd), true);
let result = await createAgentSession({ cwd, agentDir, modelRuntime, model, sessionManager: SessionManager.inMemory(cwd) });
assert.equal(result.extensionsResult.errors.length, 0);
assert.equal((await readFile(marker, "utf8")).trim(), "loaded");
result.session.dispose();
const initialMarker = await readFile(marker, "utf8");
let trustCallbackCount = 0;
const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings });
await loader.reload({ resolveProjectTrust: async () => {
  trustCallbackCount++;
  assert.equal(await readFile(marker, "utf8"), initialMarker);
  return false;
}});
result = await createAgentSession({ cwd, agentDir, modelRuntime, model, resourceLoader: loader,
  settingsManager: settings, sessionManager: SessionManager.inMemory(cwd) });
assert.equal(await readFile(marker, "utf8"), initialMarker);
result.session.dispose();
await loader.reload({ resolveProjectTrust: async () => true });
assert.equal((await readFile(marker, "utf8")).split("loaded").length - 1, 2);
const store = new ProjectTrustStore(agentDir);
store.set(root, false);
store.set(cwd, true);
assert.equal(store.get(join(cwd, "child")), true);
assert.equal(store.getEntry(cwd).path, cwd);
store.set(cwd, null);
assert.equal(store.get(cwd), false);

const services = await createAgentSessionServices({
  cwd, agentDir, modelRuntime,
  settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
  resourceLoaderReloadOptions: { resolveProjectTrust: async () => false },
  resourceLoaderOptions: {
    noExtensions: true, noSkills: true, noContextFiles: true,
    extensionFactories: [(pi) => pi.registerProvider("aa-probe", {
      api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "probe-no-network",
      models: [{ id: "probe-custom", name: "Probe", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1024, maxTokens: 64 }],
    })],
  },
});
const customModel = services.modelRuntime.getModel("aa-probe", "probe-custom");
assert.ok(customModel);
assert.equal(services.diagnostics.filter(x => x.type === "error").length, 0);
const fromServices = await createAgentSessionFromServices({ services,
  model: customModel, thinkingLevel: "off", sessionManager: SessionManager.inMemory(cwd) });
assert.equal(fromServices.session.model.provider, "aa-probe");
assert.equal(fromServices.modelFallbackMessage, undefined);
fromServices.session.dispose();

function freezeDeep(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
const parameters = Type.Object({ nested: Type.Object({ target: Type.String() }) });
const message = {
  role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "toolUse", timestamp: 1,
};
async function gateCase({ freeze = false, mutateBefore = false, nested = false, swallow = false, abort = false }) {
  const executed = [], approved = [], gates = [];
  const controller = new AbortController();
  let gateInput;
  const mutator = (pi) => pi.on("tool_call", (event) => {
    if (event.toolName !== "probe") return;
    try { event.input.nested.target = "B"; } catch (error) { if (!swallow) throw error; }
  });
  const gate = (pi) => pi.on("tool_call", (event) => {
    gates.push({ id: event.toolCallId, parent: event.parentToolCallId ?? null });
    if (freeze) freezeDeep(event.input);
    approved.push({ tool: event.toolName, target: event.input.nested.target });
    if (event.toolName === "probe") gateInput = event.input;
    if (abort) controller.abort();
  });
  const tools = (pi) => {
    pi.registerTool({ name: "probe", label: "probe", description: "Probe only",
      parameters, async execute(id, args) {
        executed.push({ target: args.nested.target, sameInput: args === gateInput,
          frozenNested: Object.isFrozen(args.nested) });
        return { content: [{ type: "text", text: args.nested.target }] };
      } });
    pi.registerTool({ name: "parent", label: "parent", description: "Calls the probe",
      parameters, async execute(id, args, signal, update, ctx) {
        const child = await ctx.executeTool("probe", structuredClone(args), { signal });
        return { ...child.result, isError: child.isError };
      } });
  };
  const resources = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [tools, ...(mutateBefore ? [mutator, gate] : [gate, mutator])],
  });
  await resources.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd, agentDir, modelRuntime, model, resourceLoader: resources, noTools: true,
    sessionManager: SessionManager.inMemory(cwd),
  });
  assert.equal(extensionsResult.errors.length, 0);
  await session.bindExtensions({});
  session.setActiveToolsByName(["probe", "parent"]);
  const call = {
    type: "toolCall", id: "probe-call", name: nested ? "parent" : "probe", arguments: { nested: { target: "A" } },
  };
  const issuedMessage = { ...message, content: [call] };
  session.agent.state.messages = [...session.agent.state.messages, issuedMessage];
  const outcome = await runToolCall(call, {
    assistantMessage: issuedMessage, context: { messages: session.agent.state.messages, tools: session.agent.state.tools },
    beforeToolCall: session.agent.beforeToolCall, signal: controller.signal,
  });
  session.dispose();
  return { executed, approved, gates, isError: outcome.isError, errorText: outcome.result?.content };
}
const unsafe = await gateCase({});
assert.equal(unsafe.approved[0].target, "A");
assert.equal(unsafe.executed[0].target, "B");
assert.equal(unsafe.executed[0].sameInput, true);
const protectedLate = await gateCase({ freeze: true });
assert.equal(protectedLate.executed.length, 0);
assert.equal(protectedLate.isError, true);
const protectedBefore = await gateCase({ freeze: true, mutateBefore: true });
assert.equal(protectedBefore.executed[0].target, "B");
assert.equal(protectedBefore.approved[0].target, "B");
assert.equal(protectedBefore.executed[0].frozenNested, true);
const silentMutation = await gateCase({ freeze: true, swallow: true });
assert.equal(silentMutation.executed[0].target, "A");
const protectedNested = await gateCase({ freeze: true, nested: true });
assert.equal(protectedNested.executed.length, 0);
assert.equal(protectedNested.isError, true);
assert.deepEqual(protectedNested.gates.map(x => x.parent), [null, "probe-call"]);
const protectedAbort = await gateCase({ freeze: true, abort: true });
assert.equal(protectedAbort.executed.length, 0);

const history = SessionManager.inMemory(cwd);
history.appendModelChange("unavailable-probe-provider", "unavailable-model");
history.appendThinkingLevelChange("high");
history.appendMessage({ role: "user", content: "probe", timestamp: 1 });
const noResources = new DefaultResourceLoader({
  cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
});
await noResources.reload();
const restored = await createAgentSession({ cwd, agentDir, modelRuntime,
  resourceLoader: noResources, sessionManager: history });
assert.match(restored.modelFallbackMessage, /Could not restore model/);
assert.equal(restored.session.model.provider, "openai");
assert.equal(restored.session.thinkingLevel, "off");
restored.session.dispose();

const uiObserved = [];
const uiResources = new DefaultResourceLoader({
  cwd, agentDir, noExtensions: true, noSkills: true, noContextFiles: true,
  settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
  extensionFactories: [(pi) => {
    pi.registerCommand("aa-ui-probe", { handler: async (args, ctx) => {
      uiObserved.push(await ctx.ui.input("raw input"));
      uiObserved.push(await ctx.ui.editor("raw editor", "prefill\n"));
      uiObserved.push(await ctx.ui.select("choice", ["first", "second"]));
      uiObserved.push(await ctx.ui.confirm("confirm", "body"));
    }});
  }],
});
await uiResources.reload();
const uiResult = await createAgentSession({ cwd, agentDir, modelRuntime, model,
  resourceLoader: uiResources, sessionManager: SessionManager.inMemory(cwd) });
await uiResult.session.bindExtensions({
  mode: "rpc", uiContext: {
    input: async () => "", editor: async (title, prefill) => { assert.equal(prefill, "prefill\n"); return " \n raw \n "; },
    select: async () => "second", confirm: async () => false, notify() {},
  },
});
let disposition;
await uiResult.session.prompt("/aa-ui-probe", { preflightResult: (value) => { disposition = value; } });
assert.equal(disposition, "handled");
assert.deepEqual(uiObserved, ["", " \n raw \n ", "second", false]);
uiResult.session.dispose();
assert.equal(modelRequests, 0);

const summary = {
  pi: "1.4.0", node: process.version, platform: process.platform, arch: process.arch,
  trust: { defaultFactoryExecutedProjectExtension: true, deniedReloadSkippedProjectExtension: true,
    allowReloadLoadedProjectExtension: true, trustCallbackCount, nearestParentAndChildRules: true,
    twoPhaseServicesAppliedExtensionProviderBeforeSession: true },
  gate: { unfrozenApprovalAExecutedB: true, frozenLateMutationExecutions: protectedLate.executed.length,
    mutationBeforeGateApprovedAndExecuted: "B", swallowedLateMutationExecuted: silentMutation.executed[0].target,
    nestedLeafExecutions: protectedNested.executed.length, nestedParentIds: protectedNested.gates.map(x=>x.parent),
    abortedLeafExecutions: protectedAbort.executed.length },
  restore: { fallbackMessage: restored.modelFallbackMessage,
    actualModel: restored.session.model.provider + "/" + restored.session.model.id, actualThinking: restored.session.thinkingLevel,
    modelRequests },
  sdkUI: { rawEmptyInputAndWhitespacePreserved: true, prefillPreserved: true, disposition },
};
await writeFile(join(process.cwd(), "result.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
console.log("probeSha256=" + createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"));
