import { AAPreferenceNames, AAPreferenceStore } from '../../storage/AAPreferences';
import { AALog } from '../../common/AAAppLog';
import { NewSessionRuntimeScope, NewSessionSelections } from './NewSessionRuntimeSelectionState';

/**
 * The last new-session target and its per-runtime choices.
 *
 * Port of `feature/sessions/NewSessionPreferenceStore.kt`.
 *
 * The key is scoped to the account (`last-selection-v2:["<server>","<user>"]`),
 * because two accounts on the same device must not inherit each other's runtime
 * or model. The previous unscoped key is adopted once, by whichever account opens
 * the page first after the upgrade — which is what Android does, quirk included.
 */

export class NewSessionPreference {
  readonly connectorId: string;
  readonly runtimeId: string;
  /** Remembered choices, keyed by `NewSessionRuntimeScope.key()`. */
  readonly selections: Map<string, NewSessionSelections>;

  constructor(
    connectorId: string,
    runtimeId: string,
    selections: Map<string, NewSessionSelections> = new Map(),
  ) {
    this.connectorId = connectorId;
    this.runtimeId = runtimeId;
    this.selections = selections;
  }
}

/** One remembered choice as stored. */
interface NewSessionSelectionDto {
  connectorId?: string;
  runtimeId?: string;
  model?: string;
  permission?: string;
}

/** The stored document. */
interface NewSessionPreferenceDto {
  connectorId?: string;
  runtimeId?: string;
  selections?: NewSessionSelectionDto[];
}

/** The stored document, built for writing. */
interface NewSessionPreferenceDocument {
  connectorId: string;
  runtimeId: string;
  selections: NewSessionSelectionDto[];
}

const LEGACY_KEY: string = 'last-selection-v1';

export class NewSessionPreferenceStore {
  private readonly store: AAPreferenceStore;
  private readonly key: string | null;

  constructor(serverUrl: string, userId: string) {
    this.store = new AAPreferenceStore(AAPreferenceNames.NEW_SESSION);
    const url: string = serverUrl.trim().replace(/\/+$/, '');
    if (url.length > 0 && userId.length > 0) {
      this.key = `last-selection-v2:${JSON.stringify([url, userId])}`;
    } else {
      this.key = null;
    }
  }

  /** The stored preference, adopting the legacy unscoped one when it exists. */
  read(): NewSessionPreference | null {
    const storageKey: string | null = this.key;
    if (storageKey === null) {
      return null;
    }
    const scoped: string = this.store.getString(storageKey, '');
    if (scoped.length > 0) {
      const decoded: NewSessionPreference | null = decodeNewSessionPreference(scoped);
      if (decoded !== null) {
        return decoded;
      }
    }
    const legacyRaw: string = this.store.getString(LEGACY_KEY, '');
    if (legacyRaw.length === 0) {
      return null;
    }
    const legacy: NewSessionPreference | null = decodeNewSessionPreference(legacyRaw);
    if (legacy === null) {
      return null;
    }
    this.store.setString(storageKey, encodeNewSessionPreference(legacy));
    this.store.delete(LEGACY_KEY);
    return legacy;
  }

  saveTarget(connectorId: string, runtimeId: string): NewSessionPreference | null {
    return this.update(connectorId, runtimeId, (previous: NewSessionSelections) => previous);
  }

  saveModel(connectorId: string, runtimeId: string, model: string): NewSessionPreference | null {
    return this.update(connectorId, runtimeId, (previous: NewSessionSelections) => {
      return new NewSessionSelections(model, previous.permission);
    });
  }

  savePermission(
    connectorId: string,
    runtimeId: string,
    permission: string,
  ): NewSessionPreference | null {
    return this.update(connectorId, runtimeId, (previous: NewSessionSelections) => {
      return new NewSessionSelections(previous.model, permission);
    });
  }

  save(
    connectorId: string,
    runtimeId: string,
    selections: NewSessionSelections,
  ): NewSessionPreference | null {
    return this.update(connectorId, runtimeId, () => selections);
  }

  /**
   * Writes one scope.
   *
   * A scope whose selections are empty is *removed* rather than stored blank, so
   * clearing both pickers forgets the runtime — matching Android, which treats an
   * all-null selection as "nothing remembered".
   */
  private update(
    connectorId: string,
    runtimeId: string,
    transform: (previous: NewSessionSelections) => NewSessionSelections,
  ): NewSessionPreference | null {
    const storageKey: string | null = this.key;
    if (storageKey === null) {
      return null;
    }
    if (connectorId.trim().length === 0 || runtimeId.trim().length === 0) {
      return null;
    }
    const scopeKey: string = scopeKeyOf(connectorId, runtimeId);
    const stored: NewSessionPreference | null = this.read();
    const previous: Map<string, NewSessionSelections> =
      stored === null ? new Map() : stored.selections;
    const selections: NewSessionSelections =
      transform(previous.get(scopeKey) ?? new NewSessionSelections());
    const nextSelections: Map<string, NewSessionSelections> = new Map(previous);
    if (selections.model === null && selections.permission === null) {
      nextSelections.delete(scopeKey);
    } else {
      nextSelections.set(scopeKey, selections);
    }
    const preference: NewSessionPreference =
      new NewSessionPreference(connectorId, runtimeId, nextSelections);
    this.store.setString(storageKey, encodeNewSessionPreference(preference));
    return preference;
  }
}

/**
 * The scope key a selection is filed under.
 *
 * Android keys its map with the `NewSessionRuntimeScope` data class; this port
 * uses the same NUL-joined string every other scope map uses.
 */
export function scopeKeyOf(connectorId: string, runtimeId: string): string {
  return new NewSessionRuntimeScope(connectorId, runtimeId).key();
}

/**
 * Serializes a preference.
 *
 * Entries are sorted by scope so the stored text is stable, and a null model or
 * permission is *omitted* rather than written as JSON null — Kotlin's
 * `JSONObject.put(name, null)` removes the key, so omitting keeps the bytes
 * identical to Android's.
 */
export function encodeNewSessionPreference(preference: NewSessionPreference): string {
  const entries: NewSessionSelectionDto[] = [];
  const scopes: string[] = Array.from(preference.selections.keys());
  scopes.sort();
  for (const scopeKey of scopes) {
    const selection: NewSessionSelections =
      preference.selections.get(scopeKey) as NewSessionSelections;
    const separator: number = scopeKey.indexOf('\u0000');
    const entry: NewSessionSelectionDto = {
      connectorId: separator >= 0 ? scopeKey.substring(0, separator) : scopeKey,
      runtimeId: separator >= 0 ? scopeKey.substring(separator + 1) : '',
    };
    if (selection.model !== null) {
      entry.model = selection.model;
    }
    if (selection.permission !== null) {
      entry.permission = selection.permission;
    }
    entries.push(entry);
  }
  const document: NewSessionPreferenceDocument = {
    connectorId: preference.connectorId,
    runtimeId: preference.runtimeId,
    selections: entries,
  };
  return JSON.stringify(document);
}

/** Reads a stored preference; a malformed document reads as absent. */
export function decodeNewSessionPreference(raw: string): NewSessionPreference | null {
  let dto: NewSessionPreferenceDto;
  try {
    dto = JSON.parse(raw) as NewSessionPreferenceDto;
  } catch (error) {
    AALog.debug(`Discarding an unreadable new-session preference: ${error instanceof Error ? error.message : 'unknown'}`);
    return null;
  }
  const connectorId: string = nonBlank(dto.connectorId);
  if (connectorId.length === 0) {
    return null;
  }
  const runtimeId: string = nonBlank(dto.runtimeId);
  if (runtimeId.length === 0) {
    return null;
  }
  const selections: Map<string, NewSessionSelections> = new Map();
  const entries: NewSessionSelectionDto[] = dto.selections ?? [];
  for (const entry of entries) {
    const entryConnectorId: string = nonBlank(entry.connectorId);
    const entryRuntimeId: string = nonBlank(entry.runtimeId);
    if (entryConnectorId.length === 0 || entryRuntimeId.length === 0) {
      continue;
    }
    const model: string | null = nonBlankOrNull(entry.model);
    const permission: string | null = nonBlankOrNull(entry.permission);
    if (model === null && permission === null) {
      continue;
    }
    selections.set(scopeKeyOf(entryConnectorId, entryRuntimeId), new NewSessionSelections(model, permission));
  }
  return new NewSessionPreference(connectorId, runtimeId, selections);
}

function nonBlank(value: string | undefined): string {
  return value === undefined || value === null ? '' : value.trim();
}

function nonBlankOrNull(value: string | undefined): string | null {
  const text: string = nonBlank(value);
  return text.length > 0 ? text : null;
}
