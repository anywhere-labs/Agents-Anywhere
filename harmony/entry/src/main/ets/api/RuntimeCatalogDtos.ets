import {
  arrayField, booleanOr, numberOr, objectField, optionalString, stringOr, stringOrFallbackWhenBlank,
} from './ApiJson';

/**
 * Runtime catalog DTOs and selection options.
 *
 * Port of the catalog portion of `api/RuntimeCatalogDtos.kt` and the option
 * builders in `feature/sessiondetail/SessionRuntimeState.kt`.
 *
 * The model catalog is a two-level structure: a model may expose reasoning
 * variants, and each variant is its own selection. The client flattens that into
 * one option per variant labelled `"<model> · <effort>"`, which is why the
 * settings sheet can group rows by the text before the separator.
 */

/** Separator the client uses to join a model with its reasoning variant. */
export const SELECTION_LABEL_SEPARATOR: string = ' · ';

// ------------------------------------------------------------------- catalogs

export interface RuntimeReasoningDto {
  id?: string;
  selectionId?: string;
  fullModelId?: string;
  displayName?: string;
  description?: string;
  default?: boolean;
  metadata?: Object;
  enabled?: boolean;
  disabledReason?: string;
}

export interface RuntimeReasoning {
  id: string;
  selectionId: string;
  fullModelId: string | null;
  displayName: string;
  description: string | null;
  default: boolean;
  metadata: Object;
  enabled: boolean;
  disabledReason: string | null;
}

export interface RuntimeModelDto {
  id?: string;
  selectionId?: string;
  displayName?: string;
  description?: string;
  default?: boolean;
  reasoningItems?: RuntimeReasoningDto[];
  metadata?: Object;
  enabled?: boolean;
  disabledReason?: string;
}

export interface RuntimeModel {
  id: string;
  selectionId: string | null;
  displayName: string;
  description: string | null;
  default: boolean;
  reasoningItems: RuntimeReasoning[];
  metadata: Object;
  enabled: boolean;
  disabledReason: string | null;
}

export interface RuntimeModelCatalogDto {
  runtime?: string;
  runtimeId?: string;
  runtimeType?: string;
  revision?: number;
  models?: RuntimeModelDto[];
}

export interface RuntimeModelCatalog {
  runtime: string;
  runtimeId: string | null;
  runtimeType: string;
  revision: number;
  models: RuntimeModel[];
}

export interface RuntimePermissionDto {
  id?: string;
  selectionId?: string;
  displayName?: string;
  description?: string;
  default?: boolean;
  metadata?: Object;
  enabled?: boolean;
  disabledReason?: string;
}

export interface RuntimePermission {
  id: string;
  selectionId: string;
  displayName: string;
  description: string | null;
  default: boolean;
  metadata: Object;
  enabled: boolean;
  disabledReason: string | null;
}

export interface RuntimePermissionCatalogDto {
  runtime?: string;
  runtimeId?: string;
  runtimeType?: string;
  revision?: number;
  permissions?: RuntimePermissionDto[];
}

export interface RuntimePermissionCatalog {
  runtime: string;
  runtimeId: string | null;
  runtimeType: string;
  revision: number;
  permissions: RuntimePermission[];
}

const EMPTY: Object = JSON.parse('{}') as Object;

/**
 * Reads `enabled`, falling back through metadata.
 *
 * The Server sometimes reports the flag only inside `metadata`, so Android checks
 * the direct field, then `metadata.enabled`, then assumes enabled.
 */
function readEnabled(direct: boolean | undefined, metadata: Object): boolean {
  if (direct !== undefined && direct !== null) {
    return direct;
  }
  const map: Record<string, Object> = metadata as Record<string, Object>;
  const fromMetadata: Object = map['enabled'];
  return typeof fromMetadata === 'boolean' ? fromMetadata : true;
}

/** Reads `disabledReason`, falling back to `metadata.disabledReason`. */
function readDisabledReason(direct: string | undefined, metadata: Object): string | null {
  const value: string | null = optionalString(direct);
  if (value !== null) {
    return value;
  }
  const map: Record<string, Object> = metadata as Record<string, Object>;
  const fromMetadata: Object = map['disabledReason'];
  return typeof fromMetadata === 'string' && fromMetadata.length > 0 ? fromMetadata : null;
}

export function parseRuntimeReasoning(dto: RuntimeReasoningDto): RuntimeReasoning {
  const metadata: Object = objectField(dto.metadata) ?? EMPTY;
  return {
    id: stringOr(dto.id, ''),
    selectionId: stringOr(dto.selectionId, ''),
    fullModelId: optionalString(dto.fullModelId),
    displayName: stringOr(dto.displayName, ''),
    description: optionalString(dto.description),
    default: booleanOr(dto.default, false),
    metadata: metadata,
    enabled: readEnabled(dto.enabled, metadata),
    disabledReason: readDisabledReason(dto.disabledReason, metadata),
  };
}

export function parseRuntimeModel(dto: RuntimeModelDto): RuntimeModel {
  const metadata: Object = objectField(dto.metadata) ?? EMPTY;
  const reasoning: RuntimeReasoning[] = [];
  for (const entry of arrayField(dto.reasoningItems)) {
    reasoning.push(parseRuntimeReasoning(entry as RuntimeReasoningDto));
  }
  return {
    id: stringOr(dto.id, ''),
    selectionId: optionalString(dto.selectionId),
    displayName: stringOr(dto.displayName, ''),
    description: optionalString(dto.description),
    default: booleanOr(dto.default, false),
    reasoningItems: reasoning,
    metadata: metadata,
    enabled: readEnabled(dto.enabled, metadata),
    disabledReason: readDisabledReason(dto.disabledReason, metadata),
  };
}

export function parseRuntimeModelCatalog(
  dto: RuntimeModelCatalogDto,
  fallbackRuntimeId: string | null,
): RuntimeModelCatalog {
  const models: RuntimeModel[] = [];
  for (const entry of arrayField(dto.models)) {
    models.push(parseRuntimeModel(entry as RuntimeModelDto));
  }
  const runtime: string = stringOrFallbackWhenBlank(
    stringOrFallbackWhenBlank(dto.runtime, dto.runtimeType ?? ''), '',
  );
  return {
    runtime: runtime,
    runtimeId: optionalString(dto.runtimeId) ?? fallbackRuntimeId ?? runtime,
    runtimeType: stringOrFallbackWhenBlank(dto.runtimeType, runtime),
    revision: numberOr(dto.revision, 0),
    models: models,
  };
}

export function parseRuntimePermission(dto: RuntimePermissionDto): RuntimePermission {
  const metadata: Object = objectField(dto.metadata) ?? EMPTY;
  return {
    id: stringOr(dto.id, ''),
    selectionId: stringOr(dto.selectionId, ''),
    displayName: stringOr(dto.displayName, ''),
    description: optionalString(dto.description),
    default: booleanOr(dto.default, false),
    metadata: metadata,
    enabled: readEnabled(dto.enabled, metadata),
    disabledReason: readDisabledReason(dto.disabledReason, metadata),
  };
}

export function parseRuntimePermissionCatalog(
  dto: RuntimePermissionCatalogDto,
  fallbackRuntimeId: string | null,
): RuntimePermissionCatalog {
  const permissions: RuntimePermission[] = [];
  for (const entry of arrayField(dto.permissions)) {
    permissions.push(parseRuntimePermission(entry as RuntimePermissionDto));
  }
  const runtime: string = stringOrFallbackWhenBlank(
    stringOrFallbackWhenBlank(dto.runtime, dto.runtimeType ?? ''), '',
  );
  return {
    runtime: runtime,
    runtimeId: optionalString(dto.runtimeId) ?? fallbackRuntimeId ?? runtime,
    runtimeType: stringOrFallbackWhenBlank(dto.runtimeType, runtime),
    revision: numberOr(dto.revision, 0),
    permissions: permissions,
  };
}

// ----------------------------------------------------------- selection options

/** One selectable option in the settings sheet. */
export interface RuntimeSelectionOption {
  selectionId: string;
  label: string;
  description: string | null;
  default: boolean;
  enabled: boolean;
  disabledReason: string | null;
}

/**
 * Flattens the model catalog into selectable options.
 *
 * A model with reasoning variants contributes one option per variant, joined by
 * the separator; a model without them contributes a single option keyed on the
 * model's own selection id. Duplicate selection ids keep the first occurrence.
 */
export function modelCatalogSelectionOptions(
  catalog: RuntimeModelCatalog | null,
): RuntimeSelectionOption[] {
  if (catalog === null) {
    return [];
  }
  const options: RuntimeSelectionOption[] = [];
  for (const model of catalog.models) {
    const reasoning: RuntimeReasoning[] = model.reasoningItems.filter(
      (item: RuntimeReasoning) => item.selectionId.length > 0,
    );
    if (reasoning.length > 0) {
      for (let index = 0; index < reasoning.length; index++) {
        const item: RuntimeReasoning = reasoning[index];
        const parts: string[] = [];
        if (model.displayName.length > 0) {
          parts.push(model.displayName);
        }
        if (item.displayName.length > 0) {
          parts.push(item.displayName);
        }
        options.push({
          selectionId: item.selectionId,
          label: parts.join(SELECTION_LABEL_SEPARATOR),
          description: item.description ?? model.description,
          // The first reasoning item of a default model counts as the default.
          default: item.default || (model.default && index === 0),
          enabled: model.enabled && item.enabled,
          disabledReason: item.disabledReason ?? model.disabledReason,
        });
      }
      continue;
    }
    const selectionId: string | null = model.selectionId;
    if (selectionId === null || selectionId.length === 0) {
      continue;
    }
    options.push({
      selectionId: selectionId,
      label: model.displayName.length > 0 ? model.displayName : model.id,
      description: model.description,
      default: model.default,
      enabled: model.enabled,
      disabledReason: model.disabledReason,
    });
  }
  return distinctBySelectionId(options);
}

export function permissionCatalogSelectionOptions(
  catalog: RuntimePermissionCatalog | null,
): RuntimeSelectionOption[] {
  if (catalog === null) {
    return [];
  }
  const options: RuntimeSelectionOption[] = [];
  for (const permission of catalog.permissions) {
    if (permission.selectionId.length === 0) {
      continue;
    }
    options.push({
      selectionId: permission.selectionId,
      label: permission.displayName.length > 0 ? permission.displayName : permission.id,
      description: permission.description,
      default: permission.default,
      enabled: permission.enabled,
      disabledReason: permission.disabledReason,
    });
  }
  return distinctBySelectionId(options);
}

function distinctBySelectionId(options: RuntimeSelectionOption[]): RuntimeSelectionOption[] {
  const seen: Set<string> = new Set();
  const out: RuntimeSelectionOption[] = [];
  for (const option of options) {
    if (!seen.has(option.selectionId)) {
      seen.add(option.selectionId);
      out.push(option);
    }
  }
  return out;
}

/**
 * Resolves the selection to show for a scope.
 *
 * An explicit selection must still exist and be enabled; otherwise the default
 * enabled option wins, then the first enabled one, and null when nothing is
 * selectable.
 */
export function validatedSelection(
  options: RuntimeSelectionOption[],
  hint: string | null,
): string | null {
  const explicit: string | null = hint !== null && hint.trim().length > 0 ? hint : null;
  if (explicit !== null) {
    for (const option of options) {
      if (option.enabled && option.selectionId === explicit) {
        return option.selectionId;
      }
    }
    return null;
  }
  for (const option of options) {
    if (option.enabled && option.default) {
      return option.selectionId;
    }
  }
  for (const option of options) {
    if (option.enabled) {
      return option.selectionId;
    }
  }
  return null;
}

/** The text before the separator, used to group model rows. */
export function selectionGroupLabel(label: string): string {
  const index: number = label.indexOf(SELECTION_LABEL_SEPARATOR);
  return index > 0 ? label.substring(0, index) : label;
}

/** Options sharing one group label, in catalog order. */
export interface RuntimeSelectionGroup {
  label: string;
  options: RuntimeSelectionOption[];
}

export function groupSelectionOptions(options: RuntimeSelectionOption[]): RuntimeSelectionGroup[] {
  const groups: RuntimeSelectionGroup[] = [];
  const indexByLabel: Map<string, number> = new Map();
  for (const option of options) {
    const label: string = selectionGroupLabel(option.label);
    const existing: number | undefined = indexByLabel.get(label);
    if (existing === undefined) {
      indexByLabel.set(label, groups.length);
      groups.push({ label: label, options: [option] });
    } else {
      groups[existing].options.push(option);
    }
  }
  return groups;
}

/** The option a group row represents: the current one, else default, else first. */
export function groupRepresentative(
  group: RuntimeSelectionGroup,
  currentSelectionId: string | null,
): RuntimeSelectionOption | null {
  if (group.options.length === 0) {
    return null;
  }
  if (currentSelectionId !== null) {
    for (const option of group.options) {
      if (option.selectionId === currentSelectionId) {
        return option;
      }
    }
  }
  for (const option of group.options) {
    if (option.enabled && option.default) {
      return option;
    }
  }
  for (const option of group.options) {
    if (option.enabled) {
      return option;
    }
  }
  return group.options[0];
}

/** True when the current selection belongs to this group. */
export function groupIsSelected(
  group: RuntimeSelectionGroup,
  currentSelectionId: string | null,
): boolean {
  if (currentSelectionId === null) {
    return false;
  }
  for (const option of group.options) {
    if (option.selectionId === currentSelectionId) {
      return true;
    }
  }
  return false;
}

/** Scopes the client reads and writes; the map is sent whole on every patch. */
export class SelectionScope {
  static readonly MODEL: string = 'model';
  static readonly PERMISSION: string = 'permission';
}
