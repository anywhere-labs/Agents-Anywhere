import {
  RuntimeModelCatalog, RuntimePermissionCatalog, SelectionScope,
} from '../../api/RuntimeCatalogDtos';

/**
 * Runtime settings state: the two live catalogs and the current selections.
 *
 * Port of the catalog and selection portion of `SessionDetailState.kt`, kept in
 * its own holder because it is loaded lazily when the settings sheet opens and
 * refreshed independently of the conversation.
 *
 * Selections are a map because the Server takes the whole map on every patch:
 * a cleared scope is sent as an explicit null, so the map must distinguish
 * "absent" from "cleared".
 */
export interface RuntimeSettingsPatch {
  selections?: Map<string, string | null>;
  modelCatalog?: RuntimeModelCatalog | null;
  permissionCatalog?: RuntimePermissionCatalog | null;
  modelLoading?: boolean;
  permissionLoading?: boolean;
  modelError?: string | null;
  permissionError?: string | null;
  /** True when a displayed catalog is the last successful one, not fresh. */
  stale?: boolean;
  /** True while a selections patch is in flight. */
  busy?: boolean;
  error?: string;
  /** Evolution counters, used to reject a catalog older than the held one. */
  modelRevision?: number;
  permissionRevision?: number;
  loaded?: boolean;
}

export class RuntimeSettingsState {
  readonly selections: Map<string, string | null>;
  readonly modelCatalog: RuntimeModelCatalog | null;
  readonly permissionCatalog: RuntimePermissionCatalog | null;
  readonly modelLoading: boolean;
  readonly permissionLoading: boolean;
  readonly modelError: string | null;
  readonly permissionError: string | null;
  readonly stale: boolean;
  readonly busy: boolean;
  readonly error: string;
  readonly modelRevision: number;
  readonly permissionRevision: number;
  readonly loaded: boolean;

  constructor(patch: Required<RuntimeSettingsPatch>) {
    this.selections = patch.selections;
    this.modelCatalog = patch.modelCatalog;
    this.permissionCatalog = patch.permissionCatalog;
    this.modelLoading = patch.modelLoading;
    this.permissionLoading = patch.permissionLoading;
    this.modelError = patch.modelError;
    this.permissionError = patch.permissionError;
    this.stale = patch.stale;
    this.busy = patch.busy;
    this.error = patch.error;
    this.modelRevision = patch.modelRevision;
    this.permissionRevision = patch.permissionRevision;
    this.loaded = patch.loaded;
  }

  static empty(): RuntimeSettingsState {
    return new RuntimeSettingsState({
      selections: new Map<string, string | null>(),
      modelCatalog: null,
      permissionCatalog: null,
      modelLoading: false,
      permissionLoading: false,
      modelError: null,
      permissionError: null,
      stale: false,
      busy: false,
      error: '',
      modelRevision: 0,
      permissionRevision: 0,
      loaded: false,
    });
  }

  copy(patch: RuntimeSettingsPatch): RuntimeSettingsState {
    return new RuntimeSettingsState({
      selections: patch.selections ?? this.selections,
      modelCatalog: patch.modelCatalog !== undefined ? patch.modelCatalog : this.modelCatalog,
      permissionCatalog: patch.permissionCatalog !== undefined
        ? patch.permissionCatalog
        : this.permissionCatalog,
      modelLoading: patch.modelLoading ?? this.modelLoading,
      permissionLoading: patch.permissionLoading ?? this.permissionLoading,
      modelError: patch.modelError !== undefined ? patch.modelError : this.modelError,
      permissionError: patch.permissionError !== undefined
        ? patch.permissionError
        : this.permissionError,
      stale: patch.stale ?? this.stale,
      busy: patch.busy ?? this.busy,
      error: patch.error ?? this.error,
      modelRevision: patch.modelRevision ?? this.modelRevision,
      permissionRevision: patch.permissionRevision ?? this.permissionRevision,
      loaded: patch.loaded ?? this.loaded,
    });
  }

  /** Absent, null and blank all mean "no selection for this scope". */
  selectionFor(scope: string): string | null {
    const value: string | null | undefined = this.selections.get(scope);
    if (value === undefined || value === null || value.length === 0) {
      return null;
    }
    return value;
  }

  modelSelection(): string | null {
    return this.selectionFor(SelectionScope.MODEL);
  }

  permissionSelection(): string | null {
    return this.selectionFor(SelectionScope.PERMISSION);
  }

  /** The map to send on a patch, with one scope replaced. */
  withSelection(scope: string, selectionId: string | null): Map<string, string | null> {
    const next: Map<string, string | null> = new Map(this.selections);
    next.set(scope, selectionId);
    return next;
  }

  /** Replaces selections from the authoritative runtime state. */
  withSelectionsFromState(selections: Map<string, string | null>): RuntimeSettingsState {
    return this.copy({ selections: selections });
  }

  /** True when the sheet has nothing to show at all. */
  hasNoOptions(): boolean {
    const modelEmpty: boolean = this.modelCatalog === null
      || this.modelCatalog.models.length === 0;
    const permissionEmpty: boolean = this.permissionCatalog === null
      || this.permissionCatalog.permissions.length === 0;
    return modelEmpty && permissionEmpty;
  }
}
