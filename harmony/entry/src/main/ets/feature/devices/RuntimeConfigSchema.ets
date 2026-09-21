import { arrayField, objectField, stringOr } from '../../api/ApiJson';

/**
 * A runtime's JSON-schema-driven configuration.
 *
 * Port of `Domain/Runtime/V2RuntimeConfig.swift` plus
 * `Models/Chat/RuntimeConfigurationModel.swift` and
 * `Models/Chat/RuntimeConfigurationRows.swift`.
 *
 * The Server publishes a JSON Schema for each runtime type: `properties` in the
 * schema, an optional `uiSchema` beside it with the presentation order, the
 * `component` of the two bespoke editors, and the extra required names a *named*
 * instance carries (`requiredForNamedInstance`). The draft below holds one
 * editable value per field, exactly as iOS's `RuntimeConfigurationModel` does:
 * text, booleans, choices, the gateway pair and the two row lists are kept in
 * their own maps so an incomplete edit (a half-typed number, an unparsable JSON
 * body) survives until the user saves.
 *
 * Nothing here touches ArkUI: the sheet owns one draft and the field editors
 * write into it, which is why `makeConfig` — not the UI — decides what is a
 * valid wire value.
 */

// ------------------------------------------------------------------- field kinds

/** `V2RuntimeConfigFieldKind`. */
export class RuntimeConfigFieldKind {
  static readonly TEXT: string = 'text';
  static readonly BOOLEAN: string = 'boolean';
  static readonly NUMBER: string = 'number';
  static readonly CHOICE: string = 'choice';
  static readonly KEY_VALUE: string = 'keyValue';
  static readonly MODEL_GATEWAY: string = 'modelGateway';
  static readonly CUSTOM_MODELS: string = 'customModels';
  static readonly JSON: string = 'json';
}

/** One `enum` entry: its JSON value plus the identity used for selection. */
export class RuntimeConfigOption {
  readonly id: string;
  readonly title: string;
  readonly value: Object | null;

  constructor(value: Object | null) {
    this.value = value;
    this.id = value === null ? 'null' : JSON.stringify(value);
    this.title = runtimeConfigOptionTitle(value);
  }
}

/** iOS's `JSONValue.displayString`, as far as an enum entry can need it. */
function runtimeConfigOptionTitle(value: Object | null): string {
  if (value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * One ordered, rendered configuration field.
 *
 * The numeric and string bounds, the `pattern`, the `enum` and everything else
 * a schema can say stay in `schema`: `validateRuntimeConfigValue` walks that
 * document directly, so a bound is never read twice from two places.
 */
export class RuntimeConfigField {
  readonly id: string;
  /** Schema `title`, or the property name when the schema has none. */
  readonly title: string;
  readonly description: string;
  readonly required: boolean;
  readonly kind: string;
  /** `component: "password" | "secure"` on a string field. */
  readonly secure: boolean;
  readonly options: RuntimeConfigOption[];
  /** The field's own JSON Schema, which validation and the gateway use. */
  readonly schema: Object;
  readonly hasDefault: boolean;
  readonly defaultValue: Object | null;
  /** `metadata.i18n.labelKey` / `descriptionKey`, `''` when absent. */
  readonly labelKey: string;
  readonly descriptionKey: string;

  constructor(
    id: string,
    title: string,
    description: string,
    required: boolean,
    kind: string,
    secure: boolean,
    options: RuntimeConfigOption[],
    schema: Object,
    hasDefault: boolean,
    defaultValue: Object | null,
    labelKey: string,
    descriptionKey: string,
  ) {
    this.id = id;
    this.title = title;
    this.description = description;
    this.required = required;
    this.kind = kind;
    this.secure = secure;
    this.options = options;
    this.schema = schema;
    this.hasDefault = hasDefault;
    this.defaultValue = defaultValue;
    this.labelKey = labelKey;
    this.descriptionKey = descriptionKey;
  }
}

// ---------------------------------------------------------------- schema reading

function asRecord(value: Object | undefined): Record<string, Object> | null {
  const object: Object | undefined = objectField(value);
  return object === undefined ? null : object as Record<string, Object>;
}

/** Whether a parsed JSON object carries a key at all. */
function recordHasKey(record: Record<string, Object>, key: string): boolean {
  return Object.keys(record).includes(key);
}

function readString(record: Record<string, Object>, key: string): string {
  return stringOr(record[key] as string, '');
}

function readNumber(record: Record<string, Object>, key: string): number | null {
  const value: Object = record[key];
  return typeof value === 'number' ? value : null;
}

function readBoolean(record: Record<string, Object>, key: string): boolean {
  return record[key] === true;
}

function readStrings(record: Record<string, Object>, key: string): string[] {
  const names: string[] = [];
  for (const entry of arrayField(record[key])) {
    if (typeof entry === 'string') {
      names.push(entry);
    }
  }
  return names;
}

/** `metadata.i18n.<key>`, or `''`. */
function readI18n(record: Record<string, Object>, key: string): string {
  const metadata: Record<string, Object> | null = asRecord(record['metadata']);
  if (metadata === null) {
    return '';
  }
  const i18n: Record<string, Object> | null = asRecord(metadata['i18n']);
  if (i18n === null) {
    return '';
  }
  return readString(i18n, key);
}

/**
 * The fields of a runtime's configuration schema, in iOS's order.
 *
 * Names listed in `uiSchema.order` come first in that order; everything else
 * follows name-sorted, which is what `V2RuntimeConfigSchema.init` produces. A
 * schema that is not an object, or that carries no `properties`, yields no
 * fields — the sheet then shows iOS's "no additional configuration" state.
 */
function parseRuntimeConfigFields(
  schema: Object | null,
  uiSchema: Object | null,
  requiresNamedInstance: boolean,
): RuntimeConfigField[] {
  const root: Record<string, Object> | null = asRecord(schema ?? undefined);
  if (root === null) {
    return [];
  }
  const properties: Record<string, Object> | null = asRecord(root['properties']);
  if (properties === null) {
    return [];
  }
  const uiRoot: Record<string, Object> = asRecord(uiSchema ?? undefined) ?? {};

  const requiredNames: Set<string> = new Set<string>();
  for (const name of readStrings(root, 'required')) {
    requiredNames.add(name);
  }
  if (requiresNamedInstance) {
    for (const name of readStrings(uiRoot, 'requiredForNamedInstance')) {
      if (recordHasKey(properties, name)) {
        requiredNames.add(name);
      }
    }
  }

  const preferred: string[] = readStrings(uiRoot, 'order');
  const ordered: string[] = [];
  for (const name of preferred) {
    if (recordHasKey(properties, name)) {
      ordered.push(name);
    }
  }
  const remaining: string[] = Object.keys(properties)
    .filter((name: string) => !preferred.includes(name));
  for (const name of remaining) {
    ordered.push(name);
  }

  const fields: RuntimeConfigField[] = [];
  for (const name of ordered) {
    const fieldSchema: Record<string, Object> = asRecord(properties[name]) ?? {};
    const uiField: Record<string, Object> = asRecord(uiRoot[name]) ?? {};
    const component: string = readString(uiField, 'component');
    fields.push(new RuntimeConfigField(
      name,
      stringOr(fieldSchema['title'] as string, name),
      readString(fieldSchema, 'description'),
      requiredNames.has(name),
      runtimeConfigFieldKind(fieldSchema, component),
      component === 'password' || component === 'secure',
      runtimeConfigOptions(fieldSchema),
      fieldSchema as Object,
      recordHasKey(fieldSchema, 'default'),
      fieldSchema['default'] ?? null,
      readI18n(fieldSchema, 'labelKey'),
      readI18n(fieldSchema, 'descriptionKey'),
    ));
  }
  return fields;
}

function runtimeConfigOptions(fieldSchema: Record<string, Object>): RuntimeConfigOption[] {
  const options: RuntimeConfigOption[] = [];
  for (const entry of arrayField(fieldSchema['enum'])) {
    options.push(new RuntimeConfigOption(entry));
  }
  return options;
}

/** `V2RuntimeConfigFieldKind.init(schema:uiSchema:)`, component first. */
function runtimeConfigFieldKind(
  fieldSchema: Record<string, Object>,
  component: string,
): string {
  if (component === 'modelGateway') {
    return RuntimeConfigFieldKind.MODEL_GATEWAY;
  }
  if (component === 'customModels') {
    return RuntimeConfigFieldKind.CUSTOM_MODELS;
  }
  if (arrayField(fieldSchema['enum']).length > 0) {
    return RuntimeConfigFieldKind.CHOICE;
  }
  const type: string = readString(fieldSchema, 'type');
  if (type === 'string') {
    return RuntimeConfigFieldKind.TEXT;
  }
  if (type === 'boolean') {
    return RuntimeConfigFieldKind.BOOLEAN;
  }
  if (type === 'integer' || type === 'number') {
    return RuntimeConfigFieldKind.NUMBER;
  }
  if (type === 'object' && (component === 'keyValue'
    || recordHasKey(fieldSchema, 'additionalProperties'))) {
    return RuntimeConfigFieldKind.KEY_VALUE;
  }
  return RuntimeConfigFieldKind.JSON;
}

/** The names a *named* instance must fill, intersected with the schema. */
function namedRequiredFieldNames(
  schema: Object | null,
  uiSchema: Object | null,
): string[] {
  const root: Record<string, Object> | null = asRecord(schema ?? undefined);
  const uiRoot: Record<string, Object> | null = asRecord(uiSchema ?? undefined);
  if (root === null || uiRoot === null) {
    return [];
  }
  const properties: Record<string, Object> | null = asRecord(root['properties']);
  if (properties === null) {
    return [];
  }
  const names: string[] = [];
  for (const name of readStrings(uiRoot, 'requiredForNamedInstance')) {
    if (recordHasKey(properties, name)) {
      names.push(name);
    }
  }
  return names;
}

// ------------------------------------------------------------------- draft rows

let nextRuntimeConfigRowId: number = 1;

function runtimeConfigRowId(prefix: string): string {
  const id: string = `${prefix}-${nextRuntimeConfigRowId}`;
  nextRuntimeConfigRowId += 1;
  return id;
}

/** `RuntimeGatewayDraft`. */
export class RuntimeGatewayDraft {
  baseUrl: string;
  apiKey: string;

  constructor(baseUrl: string = '', apiKey: string = '') {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }
}

/** `RuntimeEnvironmentRow`: one `keyValue` entry. */
export class RuntimeEnvRow {
  readonly id: string;
  key: string;
  value: string;
  removesInherited: boolean;

  constructor(key: string = '', value: string = '', removesInherited: boolean = false) {
    this.id = runtimeConfigRowId('env');
    this.key = key;
    this.value = value;
    this.removesInherited = removesInherited;
  }
}

/** `RuntimeEffortRow`. */
export class RuntimeEffortRow {
  readonly id: string;
  effortId: string;
  displayName: string;

  constructor(effortId: string = '', displayName: string = '') {
    this.id = runtimeConfigRowId('effort');
    this.effortId = effortId;
    this.displayName = displayName;
  }
}

/** `RuntimeCustomModelRow`. */
export class RuntimeModelRow {
  readonly id: string;
  modelId: string;
  displayName: string;
  efforts: RuntimeEffortRow[];

  constructor(modelId: string = '', displayName: string = '', efforts: RuntimeEffortRow[] = []) {
    this.id = runtimeConfigRowId('model');
    this.modelId = modelId;
    this.displayName = displayName;
    this.efforts = efforts;
  }
}

// ------------------------------------------------------------------- the draft

/** What `makeConfig` produces: the wire body, or one message per bad field. */
export interface RuntimeConfigOutcome {
  config: Object;
  errors: Map<string, ResourceStr>;
}

/** iOS's `RuntimeEnvironmentRow.removesInherited` marker on the wire. */
interface RuntimeGatewayValue {
  baseUrl: string;
  apiKey: string;
}

interface RuntimeCustomEffortValue {
  effortId: string;
  displayName: string;
}

interface RuntimeCustomModelValue {
  modelId: string;
  displayName: string;
  efforts?: RuntimeCustomEffortValue[];
}

function copyValues(source: Map<string, Object | null>): Map<string, Object | null> {
  const copy: Map<string, Object | null> = new Map();
  source.forEach((value: Object | null, key: string) => {
    copy.set(key, value);
  });
  return copy;
}

/**
 * The editable configuration.
 *
 * `values` starts as `defaults` merged with the runtime's saved `config` — iOS's
 * `initialValues` — and every unrecognised key is preserved verbatim, so a newer
 * Connector's field survives a round trip through this client.
 */
export class RuntimeConfigDraft {
  readonly fields: RuntimeConfigField[];
  private readonly namedRequired: string[];
  /** The descriptor's `defaults`, which `resetDefaults` restores. */
  private readonly defaults: Map<string, Object | null>;
  /** `defaults` + `config`, which `makeConfig` starts from. */
  private original: Map<string, Object | null>;
  private base: Map<string, Object | null>;
  private readonly textValues: Map<string, string> = new Map();
  private readonly boolValues: Map<string, boolean> = new Map();
  private readonly choiceIds: Map<string, string> = new Map();
  private readonly gateways: Map<string, RuntimeGatewayDraft> = new Map();
  private readonly environments: Map<string, RuntimeEnvRow[]> = new Map();
  private readonly models: Map<string, RuntimeModelRow[]> = new Map();

  public constructor(
    fields: RuntimeConfigField[],
    namedRequired: string[],
    defaults: Map<string, Object | null>,
    values: Map<string, Object | null>,
  ) {
    this.fields = fields;
    this.namedRequired = namedRequired;
    this.defaults = copyValues(defaults);
    this.original = copyValues(values);
    this.base = copyValues(values);
    this.load(values);
  }

  /**
   * Parses a runtime's or a type's schema and seeds the draft.
   *
   * `config` is the instance's saved values (absent for a type being added);
   * `requiresNamedInstance` additionally requires the `requiredForNamedInstance`
   * names, which is what iOS passes through `forNamedInstance()`.
   */
  static create(
    schema: Object | null,
    uiSchema: Object | null,
    defaults: Object,
    config: Object | null,
    requiresNamedInstance: boolean,
  ): RuntimeConfigDraft {
    const fields: RuntimeConfigField[] = parseRuntimeConfigFields(
      schema, uiSchema, requiresNamedInstance,
    );
    const defaultValues: Map<string, Object | null> = new Map();
    const defaultRecord: Record<string, Object> | null = asRecord(defaults);
    if (defaultRecord !== null) {
      for (const key of Object.keys(defaultRecord)) {
        defaultValues.set(key, defaultRecord[key]);
      }
    }
    const values: Map<string, Object | null> = copyValues(defaultValues);
    const configRecord: Record<string, Object> | null = asRecord(config ?? undefined);
    if (configRecord !== null) {
      for (const key of Object.keys(configRecord)) {
        values.set(key, configRecord[key]);
      }
    }
    for (const field of fields) {
      if (!values.has(field.id) && field.hasDefault) {
        values.set(field.id, field.defaultValue);
      }
    }
    return new RuntimeConfigDraft(
      fields, namedRequiredFieldNames(schema, uiSchema), defaultValues, values,
    );
  }

  /** iOS's `resetDefaults`, keeping what a named instance must supply itself. */
  resetDefaults(): void {
    const values: Map<string, Object | null> = copyValues(this.defaults);
    for (const field of this.fields) {
      if (!values.has(field.id) && field.hasDefault) {
        values.set(field.id, field.defaultValue);
      }
    }
    for (const name of this.namedRequired) {
      const original: Object | null | undefined = this.original.get(name);
      if (original !== undefined) {
        values.set(name, original);
      }
    }
    this.base = copyValues(values);
    this.load(values);
  }

  private load(values: Map<string, Object | null>): void {
    this.textValues.clear();
    this.boolValues.clear();
    this.choiceIds.clear();
    this.gateways.clear();
    this.environments.clear();
    this.models.clear();
    for (const field of this.fields) {
      const value: Object | null = values.get(field.id) ?? null;
      if (field.kind === RuntimeConfigFieldKind.TEXT
        || field.kind === RuntimeConfigFieldKind.NUMBER) {
        this.textValues.set(field.id, runtimeConfigTextValue(value));
      } else if (field.kind === RuntimeConfigFieldKind.JSON) {
        this.textValues.set(field.id, value === null ? '' : JSON.stringify(value, null, 2));
      } else if (field.kind === RuntimeConfigFieldKind.BOOLEAN) {
        this.boolValues.set(field.id, value === true);
      } else if (field.kind === RuntimeConfigFieldKind.CHOICE) {
        this.choiceIds.set(field.id, runtimeConfigChoiceId(field, value));
      } else if (field.kind === RuntimeConfigFieldKind.MODEL_GATEWAY) {
        const record: Record<string, Object> | null = asRecord(value ?? undefined);
        this.gateways.set(field.id, new RuntimeGatewayDraft(
          record === null ? '' : readString(record, 'baseUrl'),
          record === null ? '' : readString(record, 'apiKey'),
        ));
      } else if (field.kind === RuntimeConfigFieldKind.KEY_VALUE) {
        this.environments.set(field.id, runtimeConfigEnvRows(value));
      } else if (field.kind === RuntimeConfigFieldKind.CUSTOM_MODELS) {
        this.models.set(field.id, runtimeConfigModelRows(value));
      }
    }
  }

  // ------------------------------------------------------------- current values

  text(fieldId: string): string {
    return this.textValues.get(fieldId) ?? '';
  }

  boolean(fieldId: string): boolean {
    return this.boolValues.get(fieldId) ?? false;
  }

  choiceId(fieldId: string): string {
    return this.choiceIds.get(fieldId) ?? '';
  }

  gateway(fieldId: string): RuntimeGatewayDraft {
    return this.gateways.get(fieldId) ?? new RuntimeGatewayDraft();
  }

  envRows(fieldId: string): RuntimeEnvRow[] {
    return this.environments.get(fieldId) ?? [];
  }

  modelRows(fieldId: string): RuntimeModelRow[] {
    return this.models.get(fieldId) ?? [];
  }

  setText(fieldId: string, value: string): void {
    this.textValues.set(fieldId, value);
  }

  setBoolean(fieldId: string, value: boolean): void {
    this.boolValues.set(fieldId, value);
  }

  setChoice(fieldId: string, optionId: string): void {
    this.choiceIds.set(fieldId, optionId);
  }

  setGateway(fieldId: string, baseUrl: string, apiKey: string): void {
    this.gateways.set(fieldId, new RuntimeGatewayDraft(baseUrl, apiKey));
  }

  setEnvRows(fieldId: string, rows: RuntimeEnvRow[]): void {
    this.environments.set(fieldId, rows);
  }

  setModelRows(fieldId: string, rows: RuntimeModelRow[]): void {
    this.models.set(fieldId, rows);
  }

  /** The option matching a field's current selection, or `null`. */
  selectedOption(field: RuntimeConfigField): RuntimeConfigOption | null {
    const id: string = this.choiceId(field.id);
    for (const option of field.options) {
      if (option.id === id) {
        return option;
      }
    }
    return null;
  }

  // -------------------------------------------------------------- serialisation

  /** One field's current value as JSON, or `null` when the field is empty. */
  private fieldValue(field: RuntimeConfigField): Object | null {
    if (field.kind === RuntimeConfigFieldKind.TEXT) {
      const text: string = this.text(field.id);
      return text.length === 0 && !field.required ? null : text;
    }
    if (field.kind === RuntimeConfigFieldKind.BOOLEAN) {
      return this.boolean(field.id);
    }
    if (field.kind === RuntimeConfigFieldKind.CHOICE) {
      const option: RuntimeConfigOption | null = this.selectedOption(field);
      return option === null ? null : option.value;
    }
    if (field.kind === RuntimeConfigFieldKind.NUMBER) {
      const text: string = this.text(field.id).trim();
      if (text.length === 0) {
        return null;
      }
      const parsed: number = Number(text);
      if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
        return null;
      }
      // An integer field keeps the parsed number: iOS sends it unchanged and lets
      // the schema reject a fractional value, rather than rounding silently.
      return parsed;
    }
    if (field.kind === RuntimeConfigFieldKind.MODEL_GATEWAY) {
      const draft: RuntimeGatewayDraft = this.gateway(field.id);
      if (draft.baseUrl.length === 0 && draft.apiKey.length === 0) {
        return null;
      }
      const value: RuntimeGatewayValue = { baseUrl: draft.baseUrl, apiKey: draft.apiKey };
      return value as Object;
    }
    if (field.kind === RuntimeConfigFieldKind.KEY_VALUE) {
      // Null marks "remove this inherited variable", which is how the Connector
      // reads an explicit unset.
      const record: Record<string, Object | null> = {};
      for (const row of this.envRows(field.id)) {
        const key: string = row.key.trim();
        if (key.length === 0) {
          continue;
        }
        record[key] = row.removesInherited ? null : row.value;
      }
      return record as Object;
    }
    if (field.kind === RuntimeConfigFieldKind.CUSTOM_MODELS) {
      const items: Object[] = [];
      for (const row of this.modelRows(field.id)) {
        const modelId: string = row.modelId.trim();
        const displayName: string = row.displayName.trim();
        if (modelId.length === 0 && displayName.length === 0 && row.efforts.length === 0) {
          continue;
        }
        const efforts: RuntimeCustomEffortValue[] = [];
        for (const effort of row.efforts) {
          const effortId: string = effort.effortId.trim();
          const effortName: string = effort.displayName.trim();
          if (effortId.length === 0 && effortName.length === 0) {
            continue;
          }
          efforts.push({ effortId: effortId, displayName: effortName });
        }
        const value: RuntimeCustomModelValue = {
          modelId: modelId,
          displayName: displayName,
        };
        if (efforts.length > 0) {
          value.efforts = efforts;
        }
        items.push(value as Object);
      }
      return items as Object;
    }
    const text: string = this.text(field.id).trim();
    if (text.length === 0) {
      return null;
    }
    try {
      return JSON.parse(text) as Object;
    } catch (error) {
      return null;
    }
  }

  /**
   * The inline message for one field, or `null`.
   *
   * iOS produces these inside `makeConfig`; they are exposed per field here so a
   * single editor can show its own message without rebuilding the whole form.
   */
  errorFor(field: RuntimeConfigField): ResourceStr | null {
    const message: ResourceStr | null = this.parseError(field);
    if (message !== null) {
      return message;
    }
    const value: Object | null = this.fieldValue(field);
    if (value === null) {
      return field.required ? $r('app.string.runtime_config_required_field') : null;
    }
    return validateRuntimeConfigValue(value, field.schema);
  }

  /** The errors `makeConfig` reports itself, before the schema is consulted. */
  private parseError(field: RuntimeConfigField): ResourceStr | null {
    if (field.kind === RuntimeConfigFieldKind.NUMBER) {
      const text: string = this.text(field.id).trim();
      if (text.length === 0) {
        return null;
      }
      const parsed: number = Number(text);
      return Number.isNaN(parsed) || !Number.isFinite(parsed)
        ? $r('app.string.runtime_config_invalid_number')
        : null;
    }
    if (field.kind === RuntimeConfigFieldKind.JSON) {
      const text: string = this.text(field.id).trim();
      if (text.length === 0) {
        return null;
      }
      try {
        JSON.parse(text);
        return null;
      } catch (error) {
        return $r('app.string.runtime_config_invalid_json');
      }
    }
    if (field.kind === RuntimeConfigFieldKind.KEY_VALUE) {
      const seen: Set<string> = new Set();
      for (const row of this.envRows(field.id)) {
        const key: string = row.key.trim();
        if (key.length === 0) {
          continue;
        }
        if (seen.has(key)) {
          return $r('app.string.runtime_config_duplicate_variable');
        }
        seen.add(key);
      }
      return null;
    }
    if (field.kind === RuntimeConfigFieldKind.CUSTOM_MODELS) {
      const seen: Set<string> = new Set();
      for (const row of this.modelRows(field.id)) {
        const modelId: string = row.modelId.trim();
        const displayName: string = row.displayName.trim();
        if (modelId.length === 0 && displayName.length === 0 && row.efforts.length === 0) {
          continue;
        }
        if (seen.has(modelId)) {
          return $r('app.string.runtime_config_duplicate_model');
        }
        seen.add(modelId);
        const effortIds: Set<string> = new Set();
        for (const effort of row.efforts) {
          const effortId: string = effort.effortId.trim();
          if (effortId.length === 0 && effort.displayName.trim().length === 0) {
            continue;
          }
          if (effortIds.has(effortId)) {
            return $r('app.string.runtime_config_duplicate_effort');
          }
          effortIds.add(effortId);
        }
      }
      return null;
    }
    return null;
  }

  /**
   * The request body plus every field's message.
   *
   * Unknown keys from `defaults`/`config` are carried through, exactly as iOS's
   * `base` map is.
   */
  makeConfig(): RuntimeConfigOutcome {
    const result: Map<string, Object | null> = copyValues(this.base);
    const errors: Map<string, ResourceStr> = new Map();
    for (const field of this.fields) {
      const parseError: ResourceStr | null = this.parseError(field);
      const value: Object | null = parseError === null ? this.fieldValue(field) : null;
      if (value === null) {
        result.delete(field.id);
      } else {
        result.set(field.id, value);
      }
      if (parseError !== null) {
        errors.set(field.id, parseError);
        continue;
      }
      if (value === null) {
        if (field.required) {
          errors.set(field.id, $r('app.string.runtime_config_required_field'));
        }
        continue;
      }
      const message: ResourceStr | null = validateRuntimeConfigValue(value, field.schema);
      if (message !== null) {
        errors.set(field.id, message);
      }
    }
    const config: Record<string, Object> = {};
    result.forEach((value: Object | null, key: string) => {
      if (value !== null) {
        config[key] = value;
      }
    });
    return { config: config as Object, errors: errors };
  }
}

/** A saved `config` value as the text a text or number field edits. */
function runtimeConfigTextValue(value: Object | null): string {
  if (value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function runtimeConfigChoiceId(field: RuntimeConfigField, value: Object | null): string {
  if (value === null) {
    return '';
  }
  const id: string = JSON.stringify(value);
  for (const option of field.options) {
    if (option.id === id) {
      return id;
    }
  }
  return '';
}

/** `RuntimeEnvironmentRow` list from a saved object; keys sorted, as iOS does. */
function runtimeConfigEnvRows(value: Object | null): RuntimeEnvRow[] {
  const record: Record<string, Object> | null = asRecord(value ?? undefined);
  if (record === null) {
    return [];
  }
  const keys: string[] = Object.keys(record).sort();
  const rows: RuntimeEnvRow[] = [];
  for (const key of keys) {
    const item: Object = record[key];
    const removes: boolean = item === null || item === undefined;
    rows.push(new RuntimeEnvRow(
      key, removes ? '' : runtimeConfigTextValue(item), removes,
    ));
  }
  return rows;
}

function runtimeConfigModelRows(value: Object | null): RuntimeModelRow[] {
  const rows: RuntimeModelRow[] = [];
  const items: Object[] = Array.isArray(value) ? value as Object[] : [];
  for (const item of items) {
    const record: Record<string, Object> | null = asRecord(item);
    if (record === null) {
      continue;
    }
    const efforts: RuntimeEffortRow[] = [];
    for (const rawEffort of arrayField(record['efforts'])) {
      const effort: Record<string, Object> | null = asRecord(rawEffort);
      if (effort === null) {
        continue;
      }
      efforts.push(new RuntimeEffortRow(
        readString(effort, 'effortId'), readString(effort, 'displayName'),
      ));
    }
    rows.push(new RuntimeModelRow(
      readString(record, 'modelId'), readString(record, 'displayName'), efforts,
    ));
  }
  return rows;
}

// ------------------------------------------------------------------ validation

/** The JSON type of a parsed value, in the names a schema's `type` uses. */
function runtimeConfigJsonType(value: Object | null): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'string') {
    return 'string';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  return 'object';
}

function runtimeConfigMatchesType(value: Object | null, type: string): boolean {
  const actual: string = runtimeConfigJsonType(value);
  if (type === 'number') {
    return actual === 'number';
  }
  if (type === 'integer') {
    if (actual !== 'number') {
      return false;
    }
    const number: number = value as number;
    return Number.isFinite(number) && Math.trunc(number) === number;
  }
  return actual === type;
}

function runtimeConfigDeepEquals(left: Object | null, right: Object | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Port of `RuntimeConfigValidation.error` — the schema check iOS runs after a
 * field has been parsed, message for message.
 */
function validateRuntimeConfigValue(
  value: Object | null,
  schema: Object,
): ResourceStr | null {
  const record: Record<string, Object> | null = asRecord(schema);
  if (record === null) {
    return null;
  }
  const combinators: string[] = ['anyOf', 'oneOf'];
  for (const combinator of combinators) {
    const alternatives: Object[] = arrayField(record[combinator]);
    if (alternatives.length === 0) {
      continue;
    }
    let matches: number = 0;
    for (const alternative of alternatives) {
      const nested: Record<string, Object> | null = asRecord(alternative);
      if (nested !== null && validateRuntimeConfigValue(value, nested as Object) === null) {
        matches += 1;
      }
    }
    if (matches === 0 || (combinator === 'oneOf' && matches !== 1)) {
      return $r('app.string.runtime_config_unsupported_type');
    }
  }

  const types: string[] = [];
  for (const entry of arrayField(record['type'])) {
    if (typeof entry === 'string') {
      types.push(entry);
    }
  }
  const singleType: string = readString(record, 'type');
  if (types.length === 0 && singleType.length > 0) {
    types.push(singleType);
  }
  if (types.length > 0) {
    let matched: boolean = false;
    for (const type of types) {
      if (runtimeConfigMatchesType(value, type)) {
        matched = true;
      }
    }
    if (!matched) {
      return $r('app.string.runtime_config_unsupported_type');
    }
  }

  const options: Object[] = arrayField(record['enum']);
  if (options.length > 0) {
    let found: boolean = false;
    for (const option of options) {
      if (runtimeConfigDeepEquals(option, value)) {
        found = true;
      }
    }
    if (!found) {
      return $r('app.string.runtime_config_choose_from_options');
    }
  }

  const type: string = runtimeConfigJsonType(value);
  if (type === 'string') {
    const text: string = value as string;
    const count: number = text.length;
    const minimum: number | null = readNumber(record, 'minLength');
    if (minimum !== null && count < minimum) {
      return $r('app.string.runtime_config_required_field');
    }
    const maximum: number | null = readNumber(record, 'maxLength');
    if (maximum !== null && count > maximum) {
      return $r('app.string.runtime_config_value_too_long');
    }
    const pattern: string = readString(record, 'pattern');
    if (pattern.length > 0 && !runtimeConfigMatchesPattern(text, pattern)) {
      return $r('app.string.runtime_config_invalid_format');
    }
    return null;
  }
  if (type === 'number') {
    const number: number = value as number;
    const minimum: number | null = readNumber(record, 'minimum');
    const maximum: number | null = readNumber(record, 'maximum');
    if (!Number.isFinite(number)
      || (minimum !== null && number < minimum)
      || (maximum !== null && number > maximum)) {
      return $r('app.string.runtime_config_out_of_range');
    }
    return null;
  }
  if (type === 'array') {
    const items: Object[] = value as Object[];
    const minimum: number | null = readNumber(record, 'minItems');
    const maximum: number | null = readNumber(record, 'maxItems');
    if ((minimum !== null && items.length < minimum)
      || (maximum !== null && items.length > maximum)) {
      return $r('app.string.runtime_config_invalid_list_length');
    }
    if (readBoolean(record, 'uniqueItems')) {
      const seen: Set<string> = new Set();
      for (const item of items) {
        seen.add(JSON.stringify(item));
      }
      if (seen.size !== items.length) {
        return $r('app.string.runtime_config_duplicate_items');
      }
    }
    const itemSchema: Record<string, Object> | null = asRecord(record['items']);
    if (itemSchema !== null) {
      for (const item of items) {
        const message: ResourceStr | null = validateRuntimeConfigValue(item, itemSchema as Object);
        if (message !== null) {
          return message;
        }
      }
    }
    return null;
  }
  if (type === 'object') {
    const object: Record<string, Object> = value as Record<string, Object>;
    const properties: Record<string, Object> | null = asRecord(record['properties']);
    for (const name of readStrings(record, 'required')) {
      if (!recordHasKey(object, name)) {
        return $r('app.string.runtime_config_incomplete_group');
      }
    }
    const propertyNames: Record<string, Object> | null = asRecord(record['propertyNames']);
    const additional: Object | undefined = record['additionalProperties'];
    const additionalSchema: Record<string, Object> | null = asRecord(additional);
    for (const key of Object.keys(object)) {
      const child: Object | null = object[key];
      if (propertyNames !== null) {
        const issue: ResourceStr | null = validateRuntimeConfigValue(key, propertyNames as Object);
        if (issue !== null) {
          return issue;
        }
      }
      const property: Record<string, Object> | null = properties === null
        ? null
        : asRecord(properties[key]);
      if (property !== null) {
        const issue: ResourceStr | null = validateRuntimeConfigValue(child, property as Object);
        if (issue !== null) {
          return issue;
        }
      } else if (additional === false) {
        return $r('app.string.runtime_config_unsupported_field');
      } else if (additionalSchema !== null) {
        const issue: ResourceStr | null = validateRuntimeConfigValue(
          child, additionalSchema as Object,
        );
        if (issue !== null) {
          return issue;
        }
      }
    }
    return null;
  }
  return null;
}

/** An invalid `pattern` never rejects a value, which is what iOS's `try?` does. */
function runtimeConfigMatchesPattern(text: string, pattern: string): boolean {
  try {
    return new RegExp(pattern).test(text);
  } catch (error) {
    return true;
  }
}
