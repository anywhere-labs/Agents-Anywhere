import { DeviceRuntimeStatus, RemoteDeviceRuntime, RemoteDeviceRuntimeList } from '../../api/DevicesDtos';
import {
  RuntimeModelCatalog, RuntimeModel, RuntimePermissionCatalog, RuntimePermission, RuntimeReasoning,
} from '../../api/RuntimeCatalogDtos';
import {
  RemoteRuntimeCapability, RemoteRuntimeCapabilitySet, SessionCapability,
  findRuntimeCapability,
} from '../../api/RuntimeDtos';
import { activeNewSessionRuntimes } from './NewSessionRuntimeInventory';

/**
 * Runtime selection state for the new-session page.
 *
 * Port of `feature/sessions/NewSessionRuntimeSelectionState.kt`.
 *
 * The page asks three questions of the Server, in order, for the runtime the
 * user picked: its capabilities, then the model catalog, then the permission
 * catalog. The answers are keyed by a request key that carries a generation, so
 * a slow answer for a runtime the user has already switched away from is
 * dropped instead of overwriting the new runtime's data.
 *
 * Android keeps private copies of the capability and catalog DTOs
 * (`NewSessionRuntimeCapabilities`, `NewSessionModelCatalog`, …). This port
 * reuses the `api/` types the rest of the client already parses — the field sets
 * are identical — and calls `findRuntimeCapability` for the same lookup order.
 */

export const MODEL_CATALOG_CAPABILITY: string = SessionCapability.CATALOG_MODEL;
export const PERMISSION_CATALOG_CAPABILITY: string = SessionCapability.CATALOG_PERMISSION;
export const ATTACHMENT_CAPABILITY: string = SessionCapability.ATTACHMENT;

/** The scope a remembered selection is filed under. */
export class NewSessionRuntimeScope {
  readonly connectorId: string;
  readonly runtimeId: string;

  constructor(connectorId: string, runtimeId: string) {
    this.connectorId = connectorId;
    this.runtimeId = runtimeId;
  }

  key(): string {
    return `${this.connectorId}\u0000${this.runtimeId}`;
  }
}

/** Which request a pending answer belongs to. */
export class NewSessionRuntimeRequestKey {
  readonly connectorId: string;
  readonly runtimeId: string;
  readonly generation: number;

  constructor(connectorId: string, runtimeId: string, generation: number) {
    this.connectorId = connectorId;
    this.runtimeId = runtimeId;
    this.generation = generation;
  }

  equals(other: NewSessionRuntimeRequestKey | null): boolean {
    if (other === null) {
      return false;
    }
    return this.connectorId === other.connectorId
      && this.runtimeId === other.runtimeId
      && this.generation === other.generation;
  }
}

/** The two selections the Server accepts for a new session. */
export class NewSessionSelections {
  readonly model: string | null;
  readonly permission: string | null;

  constructor(model: string | null = null, permission: string | null = null) {
    this.model = model;
    this.permission = permission;
  }

  toMap(): Map<string, string> {
    const map: Map<string, string> = new Map();
    if (this.model !== null && this.model.trim().length > 0) {
      map.set('model', this.model);
    }
    if (this.permission !== null && this.permission.trim().length > 0) {
      map.set('permission', this.permission);
    }
    return map;
  }
}

/** Patch used by `NewSessionRemoteData.copy`; every field is optional. */
export interface NewSessionRemoteDataPatch<T> {
  data?: T | null;
  loading?: boolean;
  loaded?: boolean;
  stale?: boolean;
  errorMessage?: string | null;
  unavailableReason?: string | null;
}

/**
 * One remote value plus how fresh it is.
 *
 * `stale` is the important bit: a refresh that fails keeps the last good data on
 * screen but marks it stale, and `readyForCreate` refuses a stale catalog so a
 * session is never created from options the Server may no longer offer.
 */
export class NewSessionRemoteData<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly stale: boolean;
  readonly errorMessage: string | null;
  readonly unavailableReason: string | null;

  constructor(patch: NewSessionRemoteDataPatch<T>) {
    this.data = patch.data !== undefined ? patch.data : null;
    this.loading = patch.loading === true;
    this.loaded = patch.loaded === true;
    this.stale = patch.stale === true;
    this.errorMessage = patch.errorMessage !== undefined ? patch.errorMessage : null;
    this.unavailableReason = patch.unavailableReason !== undefined ? patch.unavailableReason : null;
  }

  static empty<T>(): NewSessionRemoteData<T> {
    return new NewSessionRemoteData<T>({});
  }

  copy(patch: NewSessionRemoteDataPatch<T>): NewSessionRemoteData<T> {
    return new NewSessionRemoteData<T>({
      data: patch.data !== undefined ? patch.data : this.data,
      loading: patch.loading !== undefined ? patch.loading : this.loading,
      loaded: patch.loaded !== undefined ? patch.loaded : this.loaded,
      stale: patch.stale !== undefined ? patch.stale : this.stale,
      errorMessage: patch.errorMessage !== undefined ? patch.errorMessage : this.errorMessage,
      unavailableReason: patch.unavailableReason !== undefined
        ? patch.unavailableReason : this.unavailableReason,
    });
  }

  /** Starts a load, keeping the previous value only when asked to. */
  begin(retainData: boolean): NewSessionRemoteData<T> {
    if (retainData) {
      return this.copy({ loading: true, stale: false, errorMessage: null, unavailableReason: null });
    }
    return new NewSessionRemoteData<T>({ loading: true });
  }

  succeed(value: T): NewSessionRemoteData<T> {
    return new NewSessionRemoteData<T>({ data: value, loaded: true });
  }

  /** The Server answered, but says this catalog is not available. */
  unavailable(reason: string | null): NewSessionRemoteData<T> {
    return new NewSessionRemoteData<T>({ loaded: true, unavailableReason: reason });
  }

  fail(message: string): NewSessionRemoteData<T> {
    return this.copy({
      loading: false,
      loaded: false,
      stale: this.data !== null,
      errorMessage: message,
      unavailableReason: null,
    });
  }

  fresh(): boolean {
    return this.loaded && !this.loading && !this.stale && this.errorMessage === null;
  }
}

/** A resolved model choice: a model plus, when the model has variants, a variant. */
class ModelSelection {
  readonly modelId: string;
  readonly reasoningId: string | null;

  constructor(modelId: string, reasoningId: string | null) {
    this.modelId = modelId;
    this.reasoningId = reasoningId;
  }
}

/** Whether a model exposes reasoning variants that carry their own selection. */
function hasReasoningSelections(model: RuntimeModel): boolean {
  return model.reasoningItems.some((item) => item.id.length > 0 && item.selectionId.trim().length > 0);
}

/** Whether a model offers anything selectable at all. */
function hasValidSelection(model: RuntimeModel): boolean {
  if (hasReasoningSelections(model)) {
    return model.reasoningItems.some(
      (item) => item.enabled && item.id.length > 0 && item.selectionId.trim().length > 0,
    );
  }
  return model.selectionId !== null && model.selectionId.trim().length > 0;
}

/**
 * Picks the model (and variant) a catalog implies.
 *
 * A remembered hint wins, then the current selection, and only then the catalog's
 * own default — so re-opening the page keeps the user's last choice even when the
 * Server's default differs.
 */
function resolveSelection(
  catalog: RuntimeModelCatalog,
  preferred: string | null,
  current: string | null,
): ModelSelection | null {
  const hints: string[] = [];
  for (const candidate of [preferred, current]) {
    if (candidate !== null && candidate.trim().length > 0 && !hints.includes(candidate)) {
      hints.push(candidate);
    }
  }
  for (const hint of hints) {
    for (const model of catalog.models.filter((entry) => entry.enabled)) {
      const validReasoning = model.reasoningItems.filter(
        (item) => item.enabled && item.id.length > 0 && item.selectionId.trim().length > 0,
      );
      for (const item of validReasoning) {
        if (item.selectionId === hint) {
          return new ModelSelection(model.id, item.id);
        }
      }
      if (!hasReasoningSelections(model) && model.selectionId === hint && model.id.length > 0) {
        return new ModelSelection(model.id, null);
      }
    }
  }
  const available: RuntimeModel[] = catalog.models.filter(
    (model) => model.enabled && model.id.length > 0 && hasValidSelection(model),
  );
  let chosen: RuntimeModel | null = null;
  for (const model of available) {
    if (model.default) {
      chosen = model;
      break;
    }
  }
  if (chosen === null) {
    chosen = available.length > 0 ? available[0] : null;
  }
  if (chosen === null) {
    return null;
  }
  const reasoning = chosen.reasoningItems.filter(
    (item) => item.enabled && item.id.length > 0 && item.selectionId.trim().length > 0,
  );
  let reasoningId: string | null = null;
  for (const item of reasoning) {
    if (item.default) {
      reasoningId = item.id;
      break;
    }
  }
  if (reasoningId === null && reasoning.length > 0) {
    reasoningId = reasoning[0].id;
  }
  return new ModelSelection(chosen.id, reasoningId);
}

/** Patch used by `NewSessionRuntimeSelectionState.copy`. */
export interface NewSessionSelectionStatePatch {
  connectorId?: string | null;
  runtimes?: RemoteDeviceRuntime[];
  runtimesLoading?: boolean;
  runtimesErrorMessage?: string | null;
  selectedRuntimeId?: string | null;
  generation?: number;
  requestKey?: NewSessionRuntimeRequestKey | null;
  capabilities?: NewSessionRemoteData<RemoteRuntimeCapabilitySet>;
  modelCatalog?: NewSessionRemoteData<RuntimeModelCatalog>;
  permissionCatalog?: NewSessionRemoteData<RuntimePermissionCatalog>;
  selectedModelId?: string | null;
  selectedReasoningId?: string | null;
  selectedPermissionId?: string | null;
  selectionHints?: Map<string, NewSessionSelections>;
}

export class NewSessionRuntimeSelectionState {
  readonly connectorId: string | null;
  readonly runtimes: RemoteDeviceRuntime[];
  readonly runtimesLoading: boolean;
  readonly runtimesErrorMessage: string | null;
  readonly selectedRuntimeId: string | null;
  readonly generation: number;
  readonly requestKey: NewSessionRuntimeRequestKey | null;
  readonly capabilities: NewSessionRemoteData<RemoteRuntimeCapabilitySet>;
  readonly modelCatalog: NewSessionRemoteData<RuntimeModelCatalog>;
  readonly permissionCatalog: NewSessionRemoteData<RuntimePermissionCatalog>;
  readonly selectedModelId: string | null;
  readonly selectedReasoningId: string | null;
  readonly selectedPermissionId: string | null;
  /** Remembered choices, keyed by `scope.key()`. */
  readonly selectionHints: Map<string, NewSessionSelections>;

  constructor(patch: NewSessionSelectionStatePatch) {
    this.connectorId = patch.connectorId !== undefined ? patch.connectorId : null;
    this.runtimes = patch.runtimes ?? [];
    this.runtimesLoading = patch.runtimesLoading === true;
    this.runtimesErrorMessage = patch.runtimesErrorMessage !== undefined
      ? patch.runtimesErrorMessage : null;
    this.selectedRuntimeId = patch.selectedRuntimeId !== undefined ? patch.selectedRuntimeId : null;
    this.generation = patch.generation ?? 0;
    this.requestKey = patch.requestKey !== undefined ? patch.requestKey : null;
    this.capabilities = patch.capabilities ?? NewSessionRemoteData.empty<RemoteRuntimeCapabilitySet>();
    this.modelCatalog = patch.modelCatalog ?? NewSessionRemoteData.empty<RuntimeModelCatalog>();
    this.permissionCatalog = patch.permissionCatalog
      ?? NewSessionRemoteData.empty<RuntimePermissionCatalog>();
    this.selectedModelId = patch.selectedModelId !== undefined ? patch.selectedModelId : null;
    this.selectedReasoningId = patch.selectedReasoningId !== undefined ? patch.selectedReasoningId : null;
    this.selectedPermissionId = patch.selectedPermissionId !== undefined
      ? patch.selectedPermissionId : null;
    this.selectionHints = patch.selectionHints ?? new Map<string, NewSessionSelections>();
  }

  static empty(): NewSessionRuntimeSelectionState {
    return new NewSessionRuntimeSelectionState({});
  }

  copy(patch: NewSessionSelectionStatePatch): NewSessionRuntimeSelectionState {
    return new NewSessionRuntimeSelectionState({
      connectorId: patch.connectorId !== undefined ? patch.connectorId : this.connectorId,
      runtimes: patch.runtimes !== undefined ? patch.runtimes : this.runtimes,
      runtimesLoading: patch.runtimesLoading !== undefined ? patch.runtimesLoading : this.runtimesLoading,
      runtimesErrorMessage: patch.runtimesErrorMessage !== undefined
        ? patch.runtimesErrorMessage : this.runtimesErrorMessage,
      selectedRuntimeId: patch.selectedRuntimeId !== undefined
        ? patch.selectedRuntimeId : this.selectedRuntimeId,
      generation: patch.generation !== undefined ? patch.generation : this.generation,
      requestKey: patch.requestKey !== undefined ? patch.requestKey : this.requestKey,
      capabilities: patch.capabilities !== undefined ? patch.capabilities : this.capabilities,
      modelCatalog: patch.modelCatalog !== undefined ? patch.modelCatalog : this.modelCatalog,
      permissionCatalog: patch.permissionCatalog !== undefined
        ? patch.permissionCatalog : this.permissionCatalog,
      selectedModelId: patch.selectedModelId !== undefined ? patch.selectedModelId : this.selectedModelId,
      selectedReasoningId: patch.selectedReasoningId !== undefined
        ? patch.selectedReasoningId : this.selectedReasoningId,
      selectedPermissionId: patch.selectedPermissionId !== undefined
        ? patch.selectedPermissionId : this.selectedPermissionId,
      selectionHints: patch.selectionHints !== undefined ? patch.selectionHints : this.selectionHints,
    });
  }

  selectedRuntime(): RemoteDeviceRuntime | null {
    for (const runtime of this.runtimes) {
      if (runtime.id === this.selectedRuntimeId) {
        return runtime;
      }
    }
    return null;
  }

  selectedModel(): RuntimeModel | null {
    const catalog: RuntimeModelCatalog | null = this.modelCatalog.data;
    if (catalog === null) {
      return null;
    }
    for (const model of catalog.models) {
      if (model.id === this.selectedModelId && model.enabled) {
        return model;
      }
    }
    return null;
  }

  /** The reasoning variants of the selected model that may be chosen. */
  reasoningOptions(): RuntimeReasoning[] {
    const model: RuntimeModel | null = this.selectedModel();
    if (model === null) {
      return [];
    }
    const options: RuntimeReasoning[] = [];
    for (const item of model.reasoningItems) {
      if (item.enabled && item.id.length > 0 && item.selectionId.trim().length > 0) {
        options.push(item);
      }
    }
    return options;
  }

  selectedReasoning(): RuntimeReasoning | null {
    for (const option of this.reasoningOptions()) {
      if (option.id === this.selectedReasoningId) {
        return option;
      }
    }
    return null;
  }

  selectedPermission(): RuntimePermission | null {
    const catalog: RuntimePermissionCatalog | null = this.permissionCatalog.data;
    if (catalog === null) {
      return null;
    }
    for (const permission of catalog.permissions) {
      if (permission.id === this.selectedPermissionId && permission.enabled) {
        return permission;
      }
    }
    return null;
  }

  /**
   * The model selection the Server should be sent.
   *
   * A model with reasoning variants contributes its *variant's* selection; when
   * variants exist but none is chosen the answer is `null` rather than the
   * model's own selection, because the Server would not know which variant was
   * meant.
   */
  selectedModelSelectionId(): string | null {
    const model: RuntimeModel | null = this.selectedModel();
    if (model === null) {
      return null;
    }
    const reasoning: RuntimeReasoning | null = this.selectedReasoning();
    if (reasoning !== null) {
      return reasoning.selectionId.trim().length > 0 ? reasoning.selectionId : null;
    }
    if (hasReasoningSelections(model)) {
      return null;
    }
    return model.selectionId !== null && model.selectionId.trim().length > 0 ? model.selectionId : null;
  }

  selectedPermissionSelectionId(): string | null {
    const permission: RuntimePermission | null = this.selectedPermission();
    if (permission === null) {
      return null;
    }
    return permission.selectionId.trim().length > 0 ? permission.selectionId : null;
  }

  selections(): NewSessionSelections {
    return new NewSessionSelections(this.selectedModelSelectionId(), this.selectedPermissionSelectionId());
  }

  modelCapability(): RemoteRuntimeCapability | null {
    const runtime: RemoteDeviceRuntime | null = this.selectedRuntime();
    const set: RemoteRuntimeCapabilitySet | null = this.capabilities.data;
    if (runtime === null || set === null) {
      return null;
    }
    return findRuntimeCapability(set, MODEL_CATALOG_CAPABILITY, runtime.id, runtime.type);
  }

  permissionCapability(): RemoteRuntimeCapability | null {
    const runtime: RemoteDeviceRuntime | null = this.selectedRuntime();
    const set: RemoteRuntimeCapabilitySet | null = this.capabilities.data;
    if (runtime === null || set === null) {
      return null;
    }
    return findRuntimeCapability(set, PERMISSION_CATALOG_CAPABILITY, runtime.id, runtime.type);
  }

  canUseModelCatalog(): boolean {
    const capability: RemoteRuntimeCapability | null = this.modelCapability();
    return capability !== null && capability.supported && capability.available && capability.allowed;
  }

  canUsePermissionCatalog(): boolean {
    const capability: RemoteRuntimeCapability | null = this.permissionCapability();
    return capability !== null && capability.supported && capability.available && capability.allowed;
  }

  canUseAttachments(): boolean {
    const runtime: RemoteDeviceRuntime | null = this.selectedRuntime();
    const set: RemoteRuntimeCapabilitySet | null = this.capabilities.data;
    if (runtime === null || set === null) {
      return false;
    }
    const capability: RemoteRuntimeCapability | null =
      findRuntimeCapability(set, ATTACHMENT_CAPABILITY, runtime.id, runtime.type);
    return capability !== null && capability.supported && capability.available && capability.allowed;
  }

  /** True when the page has everything it needs to start a session. */
  readyForCreate(): boolean {
    const runtime: RemoteDeviceRuntime | null = this.selectedRuntime();
    if (runtime === null) {
      return false;
    }
    if (!runtime.present || !runtime.configured || !runtime.active
      || runtime.status !== DeviceRuntimeStatus.RUNNING) {
      return false;
    }
    if (!this.capabilities.fresh()) {
      return false;
    }
    if (this.canUseModelCatalog()) {
      if (!this.modelCatalog.fresh()) {
        return false;
      }
      const catalog: RuntimeModelCatalog | null = this.modelCatalog.data;
      const hasModels: boolean = catalog !== null && catalog.models.length > 0;
      if (hasModels && this.selectedModelSelectionId() === null) {
        return false;
      }
    }
    if (this.canUsePermissionCatalog()) {
      if (!this.permissionCatalog.fresh()) {
        return false;
      }
      const catalog: RuntimePermissionCatalog | null = this.permissionCatalog.data;
      const hasPermissions: boolean = catalog !== null && catalog.permissions.length > 0;
      if (hasPermissions && this.selectedPermissionSelectionId() === null) {
        return false;
      }
    }
    return true;
  }

  // ------------------------------------------------------------ inventory

  beginRuntimeInventory(connectorId: string): NewSessionRuntimeSelectionState {
    if (this.connectorId === connectorId) {
      return this.copy({ runtimesLoading: true, runtimesErrorMessage: null });
    }
    return new NewSessionRuntimeSelectionState({
      connectorId: connectorId,
      runtimesLoading: true,
      generation: this.generation,
      selectionHints: this.selectionHints,
    });
  }

  /**
   * Adopts a fresh inventory.
   *
   * The selected runtime survives only while it is still selectable: a preferred
   * id wins, then the current one, then the first entry — and a change of
   * selection clears the catalogs by going through `selectRuntime`.
   */
  replaceRuntimeInventory(
    result: RemoteDeviceRuntimeList,
    preferredRuntimeId: string | null = null,
  ): NewSessionRuntimeSelectionState {
    if (result.connectorId !== this.connectorId) {
      return this;
    }
    const selectable: RemoteDeviceRuntime[] = activeNewSessionRuntimes(result.runtimes);
    let nextRuntimeId: string | null = null;
    if (preferredRuntimeId !== null && containsRuntime(selectable, preferredRuntimeId)) {
      nextRuntimeId = preferredRuntimeId;
    } else if (this.selectedRuntimeId !== null && containsRuntime(selectable, this.selectedRuntimeId)) {
      nextRuntimeId = this.selectedRuntimeId;
    } else if (selectable.length > 0) {
      nextRuntimeId = selectable[0].id;
    }
    const base: NewSessionRuntimeSelectionState = this.copy({
      runtimes: selectable,
      runtimesLoading: false,
      runtimesErrorMessage: null,
    });
    if (nextRuntimeId === this.selectedRuntimeId) {
      return base;
    }
    return base.selectRuntime(nextRuntimeId);
  }

  failRuntimeInventory(connectorId: string, message: string): NewSessionRuntimeSelectionState {
    if (this.connectorId !== connectorId) {
      return this;
    }
    return this.copy({ runtimesLoading: false, runtimesErrorMessage: message });
  }

  selectRuntime(runtimeId: string | null): NewSessionRuntimeSelectionState {
    if (runtimeId === this.selectedRuntimeId) {
      return this;
    }
    if (runtimeId !== null && !containsRuntime(this.runtimes, runtimeId)) {
      return this;
    }
    return this.copy({
      selectedRuntimeId: runtimeId,
      requestKey: null,
      capabilities: NewSessionRemoteData.empty<RemoteRuntimeCapabilitySet>(),
      modelCatalog: NewSessionRemoteData.empty<RuntimeModelCatalog>(),
      permissionCatalog: NewSessionRemoteData.empty<RuntimePermissionCatalog>(),
      selectedModelId: null,
      selectedReasoningId: null,
      selectedPermissionId: null,
    });
  }

  // ------------------------------------------------------------ catalogs

  /** Starts the three catalog loads for the selected runtime. */
  beginRuntimeDetails(): NewSessionRuntimeSelectionState {
    const currentConnectorId: string | null = this.connectorId;
    const runtimeId: string | null = this.selectedRuntimeId;
    if (currentConnectorId === null || runtimeId === null) {
      return this;
    }
    const nextGeneration: number = this.generation + 1;
    const retainData: boolean = this.requestKey !== null
      && this.requestKey.connectorId === currentConnectorId
      && this.requestKey.runtimeId === runtimeId;
    return this.copy({
      generation: nextGeneration,
      requestKey: new NewSessionRuntimeRequestKey(currentConnectorId, runtimeId, nextGeneration),
      capabilities: this.capabilities.begin(retainData),
      modelCatalog: this.modelCatalog.begin(retainData),
      permissionCatalog: this.permissionCatalog.begin(retainData),
    });
  }

  /**
   * Re-asks only for the catalogs of an already-loaded capability set.
   *
   * The retry must not repeat the capability request once that set is known
   * good: a *catalog* that failed is exactly what leaves `capabilities.fresh()`
   * true while a catalog is still not fresh, and the capability call is the
   * expensive one. A catalog the capabilities report as unavailable is left
   * alone, because there is nothing to ask for.
   */
  beginRuntimeCatalogs(): NewSessionRuntimeSelectionState {
    const currentConnectorId: string | null = this.connectorId;
    const runtimeId: string | null = this.selectedRuntimeId;
    if (currentConnectorId === null || runtimeId === null) {
      return this;
    }
    const nextGeneration: number = this.generation + 1;
    return this.copy({
      generation: nextGeneration,
      requestKey: new NewSessionRuntimeRequestKey(currentConnectorId, runtimeId, nextGeneration),
      modelCatalog: this.canUseModelCatalog()
        ? this.modelCatalog.begin(true) : this.modelCatalog,
      permissionCatalog: this.canUsePermissionCatalog()
        ? this.permissionCatalog.begin(true) : this.permissionCatalog,
    });
  }

  applyCapabilities(
    key: NewSessionRuntimeRequestKey,
    value: RemoteRuntimeCapabilitySet,
  ): NewSessionRuntimeSelectionState {
    if (!key.equals(this.requestKey)) {
      return this;
    }
    const runtime: RemoteDeviceRuntime | null = this.selectedRuntime();
    const runtimeType: string | null = runtime === null ? null : runtime.type;
    const modelCapability: RemoteRuntimeCapability | null =
      findRuntimeCapability(value, MODEL_CATALOG_CAPABILITY, key.runtimeId, runtimeType);
    const permissionCapability: RemoteRuntimeCapability | null =
      findRuntimeCapability(value, PERMISSION_CATALOG_CAPABILITY, key.runtimeId, runtimeType);
    const modelUsable: boolean = isUsable(modelCapability);
    const permissionUsable: boolean = isUsable(permissionCapability);
    return this.copy({
      capabilities: this.capabilities.succeed(value),
      modelCatalog: modelUsable
        ? this.modelCatalog.copy({ loading: true, errorMessage: null, unavailableReason: null })
        : NewSessionRemoteData.empty<RuntimeModelCatalog>()
          .unavailable(modelCapability === null ? null : modelCapability.unavailableReason),
      permissionCatalog: permissionUsable
        ? this.permissionCatalog.copy({ loading: true, errorMessage: null, unavailableReason: null })
        : NewSessionRemoteData.empty<RuntimePermissionCatalog>()
          .unavailable(permissionCapability === null ? null : permissionCapability.unavailableReason),
      selectedModelId: modelUsable ? this.selectedModelId : null,
      selectedReasoningId: modelUsable ? this.selectedReasoningId : null,
      selectedPermissionId: permissionUsable ? this.selectedPermissionId : null,
    });
  }

  failCapabilities(
    key: NewSessionRuntimeRequestKey,
    message: string,
  ): NewSessionRuntimeSelectionState {
    if (!key.equals(this.requestKey)) {
      return this;
    }
    return this.copy({
      capabilities: this.capabilities.fail(message),
      modelCatalog: this.modelCatalog.fail(message),
      permissionCatalog: this.permissionCatalog.fail(message),
    });
  }

  applyModelCatalog(
    key: NewSessionRuntimeRequestKey,
    value: RuntimeModelCatalog,
  ): NewSessionRuntimeSelectionState {
    if (!key.equals(this.requestKey)) {
      return this;
    }
    const hint: string | null = this.hintFor(key, 'model');
    const selection: ModelSelection | null =
      resolveSelection(value, hint, this.selectedModelSelectionId());
    return this.copy({
      modelCatalog: this.modelCatalog.succeed(value),
      selectedModelId: selection === null ? null : selection.modelId,
      selectedReasoningId: selection === null ? null : selection.reasoningId,
    });
  }

  failModelCatalog(
    key: NewSessionRuntimeRequestKey,
    message: string,
  ): NewSessionRuntimeSelectionState {
    if (!key.equals(this.requestKey)) {
      return this;
    }
    return this.copy({ modelCatalog: this.modelCatalog.fail(message) });
  }

  applyPermissionCatalog(
    key: NewSessionRuntimeRequestKey,
    value: RuntimePermissionCatalog,
  ): NewSessionRuntimeSelectionState {
    if (!key.equals(this.requestKey)) {
      return this;
    }
    const hint: string | null = this.hintFor(key, 'permission');
    const usable: RuntimePermission[] = value.permissions.filter(
      (permission) => permission.enabled && permission.selectionId.trim().length > 0,
    );
    let selected: RuntimePermission | null = null;
    const current: string | null = this.selectedPermissionSelectionId();
    for (const permission of usable) {
      if (hint !== null && permission.selectionId === hint) {
        selected = permission;
        break;
      }
    }
    if (selected === null && current !== null) {
      for (const permission of usable) {
        if (permission.selectionId === current) {
          selected = permission;
          break;
        }
      }
    }
    if (selected === null) {
      for (const permission of usable) {
        if (permission.id.length > 0 && permission.default) {
          selected = permission;
          break;
        }
      }
    }
    if (selected === null && usable.length > 0) {
      selected = usable[0];
    }
    return this.copy({
      permissionCatalog: this.permissionCatalog.succeed(value),
      selectedPermissionId: selected === null ? null : selected.id,
    });
  }

  failPermissionCatalog(
    key: NewSessionRuntimeRequestKey,
    message: string,
  ): NewSessionRuntimeSelectionState {
    if (!key.equals(this.requestKey)) {
      return this;
    }
    return this.copy({ permissionCatalog: this.permissionCatalog.fail(message) });
  }

  // ------------------------------------------------------------ selections

  selectModel(modelId: string): NewSessionRuntimeSelectionState {
    if (!this.modelCatalog.fresh()) {
      return this;
    }
    const catalog: RuntimeModelCatalog | null = this.modelCatalog.data;
    if (catalog === null) {
      return this;
    }
    let model: RuntimeModel | null = null;
    for (const entry of catalog.models) {
      if (entry.id === modelId && entry.enabled && hasValidSelection(entry)) {
        model = entry;
        break;
      }
    }
    if (model === null) {
      return this;
    }
    let reasoningId: string | null = null;
    for (const item of model.reasoningItems) {
      if (item.enabled && item.id.length > 0 && item.selectionId.trim().length > 0 && item.default) {
        reasoningId = item.id;
        break;
      }
    }
    if (reasoningId === null) {
      for (const item of model.reasoningItems) {
        if (item.enabled && item.id.length > 0 && item.selectionId.trim().length > 0) {
          reasoningId = item.id;
          break;
        }
      }
    }
    const next: NewSessionRuntimeSelectionState = this.copy({
      selectedModelId: model.id,
      selectedReasoningId: reasoningId,
    });
    return next.rememberSelection(next.selectedModelSelectionId(), null);
  }

  selectReasoning(reasoningId: string): NewSessionRuntimeSelectionState {
    if (!this.modelCatalog.fresh()) {
      return this;
    }
    const known: boolean = this.reasoningOptions().some((option) => option.id === reasoningId);
    if (!known) {
      return this;
    }
    const next: NewSessionRuntimeSelectionState = this.copy({ selectedReasoningId: reasoningId });
    return next.rememberSelection(next.selectedModelSelectionId(), null);
  }

  selectPermission(permissionId: string): NewSessionRuntimeSelectionState {
    if (!this.permissionCatalog.fresh()) {
      return this;
    }
    const catalog: RuntimePermissionCatalog | null = this.permissionCatalog.data;
    const valid: boolean = catalog !== null && catalog.permissions.some(
      (permission) => permission.enabled && permission.id === permissionId
        && permission.selectionId.trim().length > 0,
    );
    if (!valid) {
      return this;
    }
    const next: NewSessionRuntimeSelectionState = this.copy({ selectedPermissionId: permissionId });
    return next.rememberSelection(null, next.selectedPermissionSelectionId());
  }

  private hintFor(key: NewSessionRuntimeRequestKey, field: string): string | null {
    const scope: NewSessionSelections | undefined =
      this.selectionHints.get(new NewSessionRuntimeScope(key.connectorId, key.runtimeId).key());
    if (scope === undefined) {
      return null;
    }
    return field === 'model' ? scope.model : scope.permission;
  }

  private rememberSelection(
    model: string | null,
    permission: string | null,
  ): NewSessionRuntimeSelectionState {
    const connectorId: string | null = this.connectorId;
    const runtimeId: string | null = this.selectedRuntimeId;
    if (connectorId === null || runtimeId === null) {
      return this;
    }
    const scopeKey: string = new NewSessionRuntimeScope(connectorId, runtimeId).key();
    const previous: NewSessionSelections =
      this.selectionHints.get(scopeKey) ?? new NewSessionSelections();
    const nextHints: Map<string, NewSessionSelections> = new Map(this.selectionHints);
    nextHints.set(scopeKey, new NewSessionSelections(
      model !== null ? model : previous.model,
      permission !== null ? permission : previous.permission,
    ));
    return this.copy({ selectionHints: nextHints });
  }
}

/** The slice of a runtime list this state needs; satisfied by `RemoteDeviceRuntimeList`. */
function containsRuntime(runtimes: RemoteDeviceRuntime[], runtimeId: string): boolean {
  return runtimes.some((runtime) => runtime.id === runtimeId);
}

function isUsable(capability: RemoteRuntimeCapability | null): boolean {
  return capability !== null && capability.supported && capability.available && capability.allowed;
}
