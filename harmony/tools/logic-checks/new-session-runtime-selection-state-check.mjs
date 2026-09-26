/**
 * Runtime selection state for the new-session page.
 *
 * This is the module that decides what the user's new session will actually be
 * created with, so the assertions below pin the three rules that are easiest to
 * get wrong and most expensive to get wrong:
 *
 *   - freshness. A refresh that fails keeps the last good value on screen but
 *     marks it stale, and `readyForCreate` refuses a stale catalog, so a session
 *     is never created from options the Server may no longer offer.
 *   - staleness by request key. Every answer carries the key it was asked with,
 *     and an answer for a runtime the user has already switched away from must
 *     be dropped instead of overwriting the new runtime's data.
 *   - fallback order. A remembered choice beats the current one, which beats the
 *     catalog's own default, which beats the first selectable entry — and a
 *     model with reasoning variants contributes its *variant's* selection, or
 *     nothing at all when no variant has been chosen, because the Server would
 *     not know which variant was meant.
 */
import { loadModule, suite, expect, finish } from './lib.mjs';

const selection = await loadModule('feature/sessions/NewSessionRuntimeSelectionState.ets');
const {
  NewSessionRemoteData, NewSessionRuntimeRequestKey, NewSessionRuntimeScope,
  NewSessionRuntimeSelectionState, NewSessionSelections,
} = selection;
suite('feature/sessions/NewSessionRuntimeSelectionState.ets');

const KEY = new NewSessionRuntimeRequestKey('c1', 'r1', 1);
const STALE_KEY = new NewSessionRuntimeRequestKey('c1', 'r1', 99);
const SCOPE_KEY = new NewSessionRuntimeScope('c1', 'r1').key();

function runtime(overrides = {}) {
  return {
    connectorId: 'c1',
    id: 'r1',
    type: 'codex',
    displayName: 'Codex',
    present: true,
    configured: true,
    active: true,
    status: 'running',
    ...overrides,
  };
}

function capability(overrides = {}) {
  return {
    capabilityId: 'catalog.model',
    version: '1',
    scope: 'runtime',
    runtime: null,
    runtimeId: null,
    runtimeType: null,
    sessionId: null,
    supported: true,
    available: true,
    allowed: true,
    unavailableReason: null,
    parameters: {},
    ...overrides,
  };
}

const capabilitySet = (capabilities) => ({ revision: 1, capabilities: capabilities });

function model(overrides = {}) {
  return {
    id: 'm1',
    selectionId: 'sel-m1',
    displayName: 'Model 1',
    description: null,
    default: false,
    reasoningItems: [],
    metadata: {},
    enabled: true,
    disabledReason: null,
    ...overrides,
  };
}

function reasoning(overrides = {}) {
  return {
    id: 'low',
    selectionId: 'sel-low',
    fullModelId: null,
    displayName: 'Low',
    description: null,
    default: false,
    metadata: {},
    enabled: true,
    disabledReason: null,
    ...overrides,
  };
}

function permission(overrides = {}) {
  return {
    id: 'pA',
    selectionId: 'sel-pa',
    displayName: 'Ask',
    description: null,
    default: false,
    metadata: {},
    enabled: true,
    disabledReason: null,
    ...overrides,
  };
}

const modelCatalogOf = (models) => ({
  runtime: 'codex', runtimeId: 'r1', runtimeType: 'codex', revision: 1, models: models,
});
const permissionCatalogOf = (permissions) => ({
  runtime: 'codex', runtimeId: 'r1', runtimeType: 'codex', revision: 1, permissions: permissions,
});

/** A state sitting on the page's usual footing: one running runtime, our key. */
function state(patch = {}) {
  return new NewSessionRuntimeSelectionState({
    connectorId: 'c1',
    runtimes: [runtime()],
    selectedRuntimeId: 'r1',
    requestKey: KEY,
    ...patch,
  });
}

const MODEL_CAP_ONLY = capabilitySet([capability({ capabilityId: 'catalog.model', runtimeId: 'r1' })]);
const NO_CAPABILITIES = capabilitySet([]);

// ------------------------------------------------------- NewSessionRemoteData

const emptyValue = NewSessionRemoteData.empty();
expect('an empty remote value carries nothing: no data, not loading, not loaded, not stale',
  {
    data: emptyValue.data,
    loading: emptyValue.loading,
    loaded: emptyValue.loaded,
    stale: emptyValue.stale,
    errorMessage: emptyValue.errorMessage,
    unavailableReason: emptyValue.unavailableReason,
  },
  { data: null, loading: false, loaded: false, stale: false, errorMessage: null, unavailableReason: null });

const loadedValue = NewSessionRemoteData.empty().succeed('catalog');
expect('copy keeps the fields the patch omits, while an explicit null still clears the value',
  {
    kept: [loadedValue.copy({ loading: true }).data, loadedValue.copy({ loading: true }).loaded],
    cleared: [loadedValue.copy({ data: null }).data, loadedValue.copy({ data: null }).loaded],
  },
  { kept: ['catalog', true], cleared: [null, true] });

const droppedValue = loadedValue.begin(false);
expect('a reload that keeps nothing drops the previous value and its loaded flag',
  {
    data: droppedValue.data,
    loading: droppedValue.loading,
    loaded: droppedValue.loaded,
    stale: droppedValue.stale,
  },
  { data: null, loading: true, loaded: false, stale: false });

const retainedValue = loadedValue
  .copy({ stale: true, errorMessage: 'boom', unavailableReason: 'no catalog' })
  .begin(true);
expect('a reload that keeps the value also clears stale and both messages',
  {
    data: retainedValue.data,
    loaded: retainedValue.loaded,
    loading: retainedValue.loading,
    stale: retainedValue.stale,
    errorMessage: retainedValue.errorMessage,
    unavailableReason: retainedValue.unavailableReason,
  },
  { data: 'catalog', loaded: true, loading: true, stale: false, errorMessage: null, unavailableReason: null });

const failedValue = loadedValue.fail('network down');
const failedEmpty = NewSessionRemoteData.empty().fail('network down');
expect('fail keeps the last good value and marks it stale, but a value-less state is not stale',
  {
    stale: failedValue.stale,
    data: failedValue.data,
    loaded: failedValue.loaded,
    loading: failedValue.loading,
    errorMessage: failedValue.errorMessage,
    emptyStale: failedEmpty.stale,
    emptyData: failedEmpty.data,
  },
  {
    stale: true, data: 'catalog', loaded: false, loading: false, errorMessage: 'network down',
    emptyStale: false, emptyData: null,
  });

const unavailableValue = NewSessionRemoteData.empty().unavailable('runtime does not offer it');
expect('a catalog the Server says is unavailable is loaded, value-less, and carries its reason',
  {
    data: unavailableValue.data,
    loaded: unavailableValue.loaded,
    loading: unavailableValue.loading,
    reason: unavailableValue.unavailableReason,
    errorMessage: unavailableValue.errorMessage,
  },
  { data: null, loaded: true, loading: false, reason: 'runtime does not offer it', errorMessage: null });

expect('fresh is true only for a load that finished without a failure',
  {
    succeeded: loadedValue.fresh(),
    failed: failedValue.fresh(),
    loading: loadedValue.begin(false).fresh(),
    empty: emptyValue.fresh(),
  },
  { succeeded: true, failed: false, loading: false, empty: false });

// ----------------------------------------------------------- small value types

expect('the selection map drops blank and missing entries but sends the value as typed',
  {
    blank: Object.fromEntries(new NewSessionSelections('', '   ').toMap()),
    partial: Object.fromEntries(new NewSessionSelections(null, 'acceptEdits').toMap()),
    both: Object.fromEntries(new NewSessionSelections('sel-1', ' plan ').toMap()),
  },
  { blank: {}, partial: { permission: 'acceptEdits' }, both: { model: 'sel-1', permission: ' plan ' } });

const requestKey = new NewSessionRuntimeRequestKey('c1', 'r1', 7);
expect('the memory scope joins connector and runtime with a NUL, and a request key matches on all three parts',
  {
    scope: SCOPE_KEY,
    sameScope: SCOPE_KEY === new NewSessionRuntimeScope('c1', 'r1').key(),
    self: requestKey.equals(new NewSessionRuntimeRequestKey('c1', 'r1', 7)),
    generation: requestKey.equals(new NewSessionRuntimeRequestKey('c1', 'r1', 8)),
    runtime: requestKey.equals(new NewSessionRuntimeRequestKey('c1', 'r2', 7)),
    nothing: requestKey.equals(null),
  },
  {
    scope: 'c1\u0000r1', sameScope: true, self: true, generation: false, runtime: false, nothing: false,
  });

// --------------------------------------------------------------- readyForCreate

const blank = NewSessionRuntimeSelectionState.empty();
const awaitingCapabilities = state();
expect('a state with no runtime, and a running runtime with no capability answer, both cannot create',
  {
    noRuntime: blank.readyForCreate(),
    noRuntimeSelected: blank.selectedRuntime(),
    unanswered: awaitingCapabilities.readyForCreate(),
    unansweredFresh: awaitingCapabilities.capabilities.fresh(),
  },
  { noRuntime: false, noRuntimeSelected: null, unanswered: false, unansweredFresh: false });

const plainRuntime = state({ capabilities: NewSessionRemoteData.empty().succeed(NO_CAPABILITIES) });
expect('a running runtime with a fresh capability set and no catalog capabilities is ready',
  {
    ready: plainRuntime.readyForCreate(),
    modelCatalog: plainRuntime.canUseModelCatalog(),
    permissionCatalog: plainRuntime.canUsePermissionCatalog(),
  },
  { ready: true, modelCatalog: false, permissionCatalog: false });

const offeringModels = state({ capabilities: NewSessionRemoteData.empty().succeed(MODEL_CAP_ONLY) });
expect('a usable model capability with no catalog answer yet cannot create',
  { usable: offeringModels.canUseModelCatalog(), ready: offeringModels.readyForCreate() },
  { usable: true, ready: false });

const noUsableModel = offeringModels.applyModelCatalog(KEY, modelCatalogOf([model({ enabled: false })]));
expect('a fresh catalog whose only model is unusable leaves no selection, so create stays blocked',
  {
    selected: noUsableModel.selectedModelId,
    fresh: noUsableModel.modelCatalog.fresh(),
    ready: noUsableModel.readyForCreate(),
  },
  { selected: null, fresh: true, ready: false });

const autoSelected = offeringModels.applyModelCatalog(KEY, modelCatalogOf([model()]));
expect('a fresh catalog with a usable model adopts its selection so create can proceed',
  {
    selected: autoSelected.selectedModelId,
    reasoning: autoSelected.selectedReasoningId,
    selection: autoSelected.selectedModelSelectionId(),
    ready: autoSelected.readyForCreate(),
  },
  { selected: 'm1', reasoning: null, selection: 'sel-m1', ready: true });

const emptyCatalog = offeringModels.applyModelCatalog(KEY, modelCatalogOf([]));
expect('a fresh but empty catalog is ready, because there is nothing to choose',
  { selected: emptyCatalog.selectedModelId, ready: emptyCatalog.readyForCreate() },
  { selected: null, ready: true });

const gatedBy = (overrides) => state({
  capabilities: NewSessionRemoteData.empty().succeed(NO_CAPABILITIES),
  runtimes: [runtime(overrides)],
}).readyForCreate();
expect('present, configured, active and running are each required to create',
  {
    running: gatedBy({}),
    present: gatedBy({ present: false }),
    configured: gatedBy({ configured: false }),
    active: gatedBy({ active: false }),
    status: gatedBy({ status: 'starting' }),
  },
  { running: true, present: false, configured: false, active: false, status: false });

// ------------------------------------------------------------- capability gates

const withCapability = (entry) => state({
  capabilities: NewSessionRemoteData.empty().succeed(capabilitySet([entry])),
});
expect('a capability is usable only when supported, available and allowed, and a missing entry counts as unusable',
  {
    missing: state({ capabilities: NewSessionRemoteData.empty().succeed(NO_CAPABILITIES) }).canUseAttachments(),
    attachments: withCapability(capability({ capabilityId: 'runtime.attachment', runtimeId: 'r1' })).canUseAttachments(),
    attachmentsDenied: withCapability(capability({ capabilityId: 'runtime.attachment', runtimeId: 'r1', allowed: false })).canUseAttachments(),
    attachmentsUnsupported: withCapability(capability({ capabilityId: 'runtime.attachment', runtimeId: 'r1', supported: false })).canUseAttachments(),
    attachmentsUnavailable: withCapability(capability({ capabilityId: 'runtime.attachment', runtimeId: 'r1', available: false })).canUseAttachments(),
    model: offeringModels.canUseModelCatalog(),
    modelDenied: withCapability(capability({ capabilityId: 'catalog.model', runtimeId: 'r1', allowed: false })).canUseModelCatalog(),
    permission: withCapability(capability({ capabilityId: 'catalog.permission', runtimeId: 'r1' })).canUsePermissionCatalog(),
    permissionDenied: withCapability(capability({ capabilityId: 'catalog.permission', runtimeId: 'r1', supported: false })).canUsePermissionCatalog(),
  },
  {
    missing: false, attachments: true, attachmentsDenied: false, attachmentsUnsupported: false,
    attachmentsUnavailable: false, model: true, modelDenied: false, permission: true,
    permissionDenied: false,
  });

// ------------------------------------------------------- selection ids and order

const variantModel = model({
  id: 'm2',
  selectionId: 'sel-m2',
  reasoningItems: [
    reasoning({ id: 'low', selectionId: 'sel-low', default: true }),
    reasoning({ id: 'high', selectionId: 'sel-high' }),
  ],
});
const withVariants = offeringModels.applyModelCatalog(KEY, modelCatalogOf([variantModel]));
expect('a model with variants sends the variant\'s selection, and nothing until a variant is chosen',
  {
    autoChosen: withVariants.selectedReasoningId,
    chosen: withVariants.copy({ selectedReasoningId: 'high' }).selectedModelSelectionId(),
    notChosen: withVariants.copy({ selectedReasoningId: null }).selectedModelSelectionId(),
    plainModel: autoSelected.selectedModelSelectionId(),
  },
  { autoChosen: 'low', chosen: 'sel-high', notChosen: null, plainModel: 'sel-m1' });

const twoRuntimes = state({ runtimes: [runtime(), runtime({ id: 'r2', displayName: 'Claude Code' })] });
const carrying = twoRuntimes.copy({ selectedModelId: 'm1', selectedPermissionId: 'pA' });
const switched = carrying.selectRuntime('r2');
expect('selecting another runtime clears the catalogs and both selections, and no runtime clears the id',
  {
    id: switched.selectedRuntimeId,
    capabilities: switched.capabilities.data,
    modelCatalog: switched.modelCatalog.data,
    permissionCatalog: switched.permissionCatalog.data,
    requestKey: switched.requestKey,
    model: switched.selectedModelId,
    reasoning: switched.selectedReasoningId,
    permission: switched.selectedPermissionId,
    afterNoRuntime: carrying.selectRuntime(null).selectedRuntimeId,
  },
  {
    id: 'r2', capabilities: null, modelCatalog: null, permissionCatalog: null, requestKey: null,
    model: null, reasoning: null, permission: null, afterNoRuntime: null,
  });
expect('re-selecting the current runtime or an unknown one changes nothing',
  {
    current: carrying.selectRuntime('r1') === carrying,
    unknown: carrying.selectRuntime('nope') === carrying,
  },
  { current: true, unknown: true });

const twoModels = modelCatalogOf([
  model({ id: 'mA', selectionId: 'sel-a', default: true }),
  model({ id: 'mB', selectionId: 'sel-b' }),
]);
const firstModel = modelCatalogOf([
  model({ id: 'mX', selectionId: 'sel-x' }),
  model({ id: 'mY', selectionId: 'sel-y' }),
]);
const hinted = state({
  capabilities: NewSessionRemoteData.empty().succeed(MODEL_CAP_ONLY),
  selectionHints: new Map([[SCOPE_KEY, new NewSessionSelections('sel-b', null)]]),
});
expect('a stale request key is dropped, and the remembered choice then the current one beat the catalog default',
  {
    staleDropped: offeringModels.applyModelCatalog(STALE_KEY, twoModels) === offeringModels,
    byDefault: offeringModels.applyModelCatalog(KEY, twoModels).selectedModelId,
    byHint: hinted.applyModelCatalog(KEY, twoModels).selectedModelId,
    byCurrent: offeringModels.applyModelCatalog(KEY, twoModels)
      .copy({ selectedModelId: 'mB' }).applyModelCatalog(KEY, twoModels).selectedModelId,
    byFirst: offeringModels.applyModelCatalog(KEY, firstModel).selectedModelId,
  },
  { staleDropped: true, byDefault: 'mA', byHint: 'mB', byCurrent: 'mB', byFirst: 'mX' });

// ------------------------------------------------------------------ capabilities

const beforeCapabilities = state({ capabilities: NewSessionRemoteData.empty() });
const started = beforeCapabilities.applyCapabilities(KEY, MODEL_CAP_ONLY);
const denied = beforeCapabilities
  .copy({ selectedModelId: 'm1', selectedReasoningId: 'low', selectedPermissionId: 'pA' })
  .applyCapabilities(KEY, capabilitySet([
    capability({ capabilityId: 'catalog.model', runtimeId: 'r1', allowed: false, unavailableReason: 'not allowed' }),
    capability({ capabilityId: 'catalog.permission', runtimeId: 'r1', supported: false, unavailableReason: 'unsupported' }),
  ]));
expect('capabilities start the catalogs they allow and pin the reason on the ones they deny',
  {
    started: [
      started.capabilities.loaded,
      started.modelCatalog.data,
      started.modelCatalog.loading,
      started.permissionCatalog.data,
      started.permissionCatalog.unavailableReason,
    ],
    denied: [
      denied.modelCatalog.loading,
      denied.modelCatalog.data,
      denied.modelCatalog.unavailableReason,
      denied.permissionCatalog.unavailableReason,
      denied.selectedModelId,
      denied.selectedReasoningId,
      denied.selectedPermissionId,
    ],
    staleDropped: beforeCapabilities.applyCapabilities(STALE_KEY, MODEL_CAP_ONLY) === beforeCapabilities,
  },
  {
    started: [true, null, true, null, null],
    denied: [false, null, 'not allowed', 'unsupported', null, null, null],
    staleDropped: true,
  });

const permissions = permissionCatalogOf([
  permission({ id: 'pA', selectionId: 'sel-pa', default: true }),
  permission({ id: 'pB', selectionId: 'sel-pb' }),
]);
const permissionState = state({
  capabilities: NewSessionRemoteData.empty().succeed(
    capabilitySet([capability({ capabilityId: 'catalog.permission', runtimeId: 'r1' })]),
  ),
});
const byDefaultPermission = permissionState.applyPermissionCatalog(KEY, permissions);
const byHintPermission = state({
  capabilities: permissionState.capabilities,
  selectionHints: new Map([[SCOPE_KEY, new NewSessionSelections(null, 'sel-pb')]]),
}).applyPermissionCatalog(KEY, permissions);
const disabledPermission = permissionState.applyPermissionCatalog(KEY, permissionCatalogOf([
  permission({ id: 'pA', selectionId: 'sel-pa', enabled: false }),
]));
expect('the permission catalog prefers a remembered choice over the default, and a disabled one cannot be picked',
  {
    byDefault: byDefaultPermission.selectedPermissionId,
    byHint: byHintPermission.selectedPermissionId,
    chosen: byDefaultPermission.selectPermission('pB').selectedPermissionId,
    chosenSelection: byDefaultPermission.selectPermission('pB').selectedPermissionSelectionId(),
    unknown: byDefaultPermission.selectPermission('nope') === byDefaultPermission,
    disabledSelected: disabledPermission.selectedPermissionId,
    disabledRefused: disabledPermission.selectPermission('pA') === disabledPermission,
  },
  {
    byDefault: 'pA', byHint: 'pB', chosen: 'pB', chosenSelection: 'sel-pb', unknown: true,
    disabledSelected: null, disabledRefused: true,
  });

// -------------------------------------------------------------------- inventory

const inventoryState = state({
  runtimes: [runtime(), runtime({ id: 'r2' })],
  capabilities: NewSessionRemoteData.empty().succeed(MODEL_CAP_ONLY),
  modelCatalog: NewSessionRemoteData.empty().succeed(modelCatalogOf([model()])),
  selectedModelId: 'm1',
});
const inventory = (runtimes) => ({ connectorId: 'c1', runtimes: runtimes, serverTime: null });
const keptInventory = inventoryState.replaceRuntimeInventory(inventory([runtime(), runtime({ id: 'r2' })]), null);
const droppedRuntime = inventoryState.replaceRuntimeInventory(inventory([runtime({ id: 'r2' })]), null);
const preferredRuntime = inventoryState.replaceRuntimeInventory(inventory([runtime(), runtime({ id: 'r2' })]), 'r2');
expect('a fresh inventory keeps a still-selectable runtime, otherwise adopts the preferred or first one and clears the catalogs',
  {
    kept: [
      keptInventory.selectedRuntimeId,
      keptInventory.capabilities === inventoryState.capabilities,
      keptInventory.modelCatalog === inventoryState.modelCatalog,
    ],
    dropped: [
      droppedRuntime.selectedRuntimeId,
      droppedRuntime.capabilities.data,
      droppedRuntime.modelCatalog.data,
      droppedRuntime.selectedModelId,
      droppedRuntime.requestKey,
    ],
    preferred: preferredRuntime.selectedRuntimeId,
    otherConnector: inventoryState.replaceRuntimeInventory({
      connectorId: 'c2', runtimes: [runtime({ id: 'r2' })], serverTime: null,
    }, null) === inventoryState,
  },
  {
    kept: ['r1', true, true],
    dropped: ['r2', null, null, null, null],
    preferred: 'r2',
    otherConnector: true,
  });

const detailsState = state({
  generation: 4,
  capabilities: NewSessionRemoteData.empty().succeed(MODEL_CAP_ONLY),
  modelCatalog: NewSessionRemoteData.empty().succeed(modelCatalogOf([model()])),
  selectedModelId: 'm1',
});
const sameRuntimeDetails = detailsState.beginRuntimeDetails();
const otherRuntimeDetails = state({
  generation: 4,
  requestKey: new NewSessionRuntimeRequestKey('c1', 'r2', 9),
  capabilities: NewSessionRemoteData.empty().succeed(MODEL_CAP_ONLY),
  modelCatalog: NewSessionRemoteData.empty().succeed(modelCatalogOf([model()])),
}).beginRuntimeDetails();
expect('the details load bumps the generation, and keeps the previous catalogs only for the same runtime',
  {
    generation: sameRuntimeDetails.generation,
    key: sameRuntimeDetails.requestKey.equals(new NewSessionRuntimeRequestKey('c1', 'r1', 5)),
    retained: [
      sameRuntimeDetails.capabilities.data !== null,
      sameRuntimeDetails.modelCatalog.data !== null,
      sameRuntimeDetails.modelCatalog.loading,
    ],
    dropped: [
      otherRuntimeDetails.generation,
      otherRuntimeDetails.capabilities.data,
      otherRuntimeDetails.modelCatalog.data,
      otherRuntimeDetails.modelCatalog.loading,
    ],
  },
  {
    generation: 5,
    key: true,
    retained: [true, true, true],
    dropped: [5, null, null, true],
  });

finish();
