/**
 * The runtime configuration sheet's logic - schema reading, the draft and the
 * wire body.
 *
 * This module is where "Save" decides what the Server is told, so the rules
 * pinned here are the ones a user meets: the Server's `uiSchema.order` is
 * honoured and everything else is name-sorted, an enum-less object is an opaque
 * JSON editor while `additionalProperties` makes it a key/value list, an
 * incomplete edit (a half-typed number, a broken JSON body) is reported per
 * field instead of being sent, an unset environment variable goes out as an
 * explicit `null` so the Connector knows to remove the inherited value, and a
 * "reset to defaults" keeps what a named instance had to supply itself.
 *
 * `$r(...)` is ArkUI's resource lookup, so the check installs one shim before
 * calling the module: `$r('app.string.x')` returns that key, which is what lets
 * each message below be asserted exactly. The shim replaces a resource lookup
 * only - every rule under test is the shipped code, loaded through the harness
 * mirror from `feature/devices/RuntimeConfigSchema.ets`. Modules that really
 * cannot load (an `@ohos.*` import, an ArkUI component) are skipped instead.
 */
import { loadModule, suite, expect, finish } from './lib.mjs';

globalThis.$r = (key) => key;

const configSchema = await loadModule('feature/devices/RuntimeConfigSchema.ets');
const {
  RuntimeConfigDraft, RuntimeConfigOption, RuntimeEnvRow, RuntimeModelRow, RuntimeEffortRow,
} = configSchema;

suite('feature/devices/RuntimeConfigSchema.ets');

const REQUIRED = 'app.string.runtime_config_required_field';
const UNSUPPORTED = 'app.string.runtime_config_unsupported_type';

/** A schema with one of every field kind plus the presentation rules. */
const SCHEMA = {
  type: 'object',
  required: ['apiKey'],
  properties: {
    zeta: { type: 'string' },
    apiKey: {
      type: 'string', title: 'API key', description: 'the key', minLength: 3,
      metadata: { i18n: { labelKey: 'i18n.apiKey.label', descriptionKey: 'i18n.apiKey.description' } },
    },
    alpha: { type: 'boolean', default: true },
    mode: { enum: ['fast', null, 3] },
    temps: { type: 'number', minimum: 0, maximum: 1 },
    count: { type: 'integer' },
    env: { type: 'object', additionalProperties: true },
    gateway: { type: 'object' },
    models: { type: 'array' },
    payload: { type: 'object' },
  },
};
const UI_SCHEMA = {
  order: ['mode', 'apiKey', 'ghost'],
  apiKey: { component: 'password' },
  env: { component: 'keyValue' },
  gateway: { component: 'modelGateway' },
  models: { component: 'customModels' },
  requiredForNamedInstance: ['zeta', 'ghost'],
};

const fields = RuntimeConfigDraft.create(SCHEMA, UI_SCHEMA, {}, null, true).fields;
const fieldById = new Map(fields.map((field) => [field.id, field]));

/** A fresh draft over SCHEMA: defaults plus a saved config, as the sheet opens. */
function draft(config, requiresNamedInstance) {
  return RuntimeConfigDraft.create(
    SCHEMA, UI_SCHEMA, { apiKey: 'dflt', alpha: false, extra: 'keep' },
    config === undefined ? { apiKey: 'saved', zeta: 'z' } : config,
    requiresNamedInstance === undefined ? true : requiresNamedInstance,
  );
}

/** The wire body and the messages, in a shape `expect` can compare. */
function outcomeOf(active) {
  const outcome = active.makeConfig();
  return { config: outcome.config, errors: Object.fromEntries(outcome.errors) };
}

// ---------------------------------------------------------- reading the schema

expect('fields follow uiSchema.order, then the remaining names sorted',
  fields.map((field) => field.id),
  ['mode', 'apiKey', 'alpha', 'count', 'env', 'gateway', 'models', 'payload', 'temps', 'zeta']);
expect('each field kind comes from the uiSchema component first, then the type',
  fields.map((field) => `${field.id}=${field.kind}`),
  ['mode=choice', 'apiKey=text', 'alpha=boolean', 'count=number', 'env=keyValue',
    'gateway=modelGateway', 'models=customModels', 'payload=json', 'temps=number', 'zeta=text']);
expect('required names are the schema required plus the named-instance extras that exist',
  [
    fields.filter((field) => field.required).map((field) => field.id),
    RuntimeConfigDraft.create(SCHEMA, UI_SCHEMA, {}, null, false).fields
      .filter((field) => field.required).map((field) => field.id),
  ],
  [['apiKey', 'zeta'], ['apiKey']]);
expect('the title falls back to the property name, and the i18n keys to empty',
  [
    [fieldById.get('apiKey').title, fieldById.get('apiKey').description,
      fieldById.get('apiKey').labelKey, fieldById.get('apiKey').descriptionKey],
    [fieldById.get('zeta').title, fieldById.get('zeta').description,
      fieldById.get('zeta').labelKey, fieldById.get('zeta').descriptionKey],
  ],
  [['API key', 'the key', 'i18n.apiKey.label', 'i18n.apiKey.description'],
    ['zeta', '', '', '']]);
expect('only the field the uiSchema marks as a password is secure',
  fields.filter((field) => field.secure).map((field) => field.id), ['apiKey']);
expect('a schema default is kept as the field default, absence is not',
  [
    [fieldById.get('alpha').hasDefault, fieldById.get('alpha').defaultValue],
    [fieldById.get('apiKey').hasDefault, fieldById.get('apiKey').defaultValue],
  ],
  [[true, true], [false, null]]);
expect('an enum entry keeps its JSON identity so it can be selected by value',
  [
    fieldById.get('mode').options.map((option) => [option.id, option.title]),
    [new RuntimeConfigOption(null).id, new RuntimeConfigOption(null).title],
    [new RuntimeConfigOption(true).id, new RuntimeConfigOption(true).title],
    [new RuntimeConfigOption({ a: 1 }).id, new RuntimeConfigOption({ a: 1 }).title],
  ],
  [
    [['"fast"', 'fast'], ['null', ''], ['3', '3']],
    ['null', ''],
    ['true', 'true'],
    ['{"a":1}', '{"a":1}'],
  ]);

// ----------------------------------------------------------------- the draft

const opened = draft();
expect('the sheet opens on defaults merged with the saved config',
  [
    opened.text('apiKey'), opened.boolean('alpha'), opened.text('count'), opened.choiceId('mode'),
    JSON.stringify(opened.gateway('gateway')), opened.envRows('env').length,
    opened.modelRows('models').length,
  ],
  ['saved', false, '', '', '{"baseUrl":"","apiKey":""}', 0, 0]);
expect('an untouched sheet sends the saved values and reports nothing',
  [
    Object.keys(outcomeOf(opened).config).sort(),
    outcomeOf(opened).errors.apiKey === undefined,
    outcomeOf(opened).config.apiKey,
    outcomeOf(opened).config.zeta,
  ],
  [['alpha', 'apiKey', 'env', 'extra', 'models', 'zeta'], true, 'saved', 'z']);

expect('a schema failure keeps the value in the body; the message is what stops the save',
  (() => {
    const active = draft();
    active.setText('apiKey', '');
    const empty = outcomeOf(active);
    active.setText('apiKey', 'saved');
    active.setText('temps', '2');
    const ranged = outcomeOf(active);
    return [empty.config.apiKey, empty.errors.apiKey, ranged.config.temps, ranged.errors.temps];
  })(),
  ['', REQUIRED, 2, 'app.string.runtime_config_out_of_range']);
expect('a value shorter than minLength is reported but still sent',
  (() => {
    const active = draft();
    active.setText('apiKey', 'ab');
    const result = outcomeOf(active);
    return [result.config.apiKey, result.errors.apiKey];
  })(),
  ['ab', REQUIRED]);
expect('a number field sends a number, and refuses to guess at nonsense',
  (() => {
    const active = draft();
    active.setText('count', '12');
    const parsed = outcomeOf(active);
    active.setText('count', 'abc');
    const broken = outcomeOf(active);
    return [parsed.config.count, typeof parsed.config.count, 'count' in broken.config,
      broken.errors.count];
  })(),
  [12, 'number', false, 'app.string.runtime_config_invalid_number']);
expect('a fractional integer is reported by the schema rather than rounded',
  (() => {
    const active = draft();
    active.setText('count', '1.5');
    active.setText('temps', '0.5');
    const result = outcomeOf(active);
    return [result.config.count, result.errors.count, result.config.temps,
      result.errors.temps === undefined];
  })(),
  [1.5, UNSUPPORTED, 0.5, true]);
expect('a choice the enum does not offer serialises to nothing, and a number option to a number',
  (() => {
    const active = draft();
    active.setChoice('mode', '"fast"');
    const fast = outcomeOf(active).config.mode;
    active.setChoice('mode', '3');
    const numeric = outcomeOf(active).config.mode;
    active.setChoice('mode', '"nope"');
    const unknown = outcomeOf(active);
    return [fast, numeric, 'mode' in unknown.config, Object.keys(unknown.errors).length];
  })(),
  ['fast', 3, false, 0]);
expect('the gateway pair is sent as a whole and dropped when both halves are empty',
  (() => {
    const active = draft();
    active.setGateway('gateway', 'https://gw', 'sk-1');
    const filled = JSON.stringify(outcomeOf(active).config.gateway);
    active.setGateway('gateway', '', '');
    const empty = outcomeOf(active);
    return [filled, 'gateway' in empty.config];
  })(),
  ['{"baseUrl":"https://gw","apiKey":"sk-1"}', false]);
expect('environment rows become an object keyed by the trimmed name',
  (() => {
    const active = draft();
    active.setEnvRows('env', [
      new RuntimeEnvRow('B', '2'), new RuntimeEnvRow(' A ', '1'),
      new RuntimeEnvRow('  ', 'ignored'), new RuntimeEnvRow('C', '', true),
    ]);
    const env = outcomeOf(active).config.env;
    return [Object.keys(env), env.B, env.A, JSON.stringify(env.C)];
  })(),
  [['B', 'A', 'C'], '2', '1', 'null']);
expect('two rows for the same variable are reported and the whole group is dropped',
  (() => {
    const active = draft();
    active.setEnvRows('env', [new RuntimeEnvRow('A', '1'), new RuntimeEnvRow('A', '2')]);
    const result = outcomeOf(active);
    return ['env' in result.config, result.errors.env];
  })(),
  [false, 'app.string.runtime_config_duplicate_variable']);
expect('custom models keep their nested efforts and skip the blank rows',
  (() => {
    const active = draft();
    active.setModelRows('models', [
      new RuntimeModelRow('m1', ' M1 ', [new RuntimeEffortRow('low', 'Low')]),
      new RuntimeModelRow('', '', []),
      new RuntimeModelRow('m2', 'M2', [new RuntimeEffortRow('', '')]),
    ]);
    return JSON.stringify(outcomeOf(active).config.models);
  })(),
  '[{"modelId":"m1","displayName":"M1","efforts":[{"effortId":"low","displayName":"Low"}]},'
    + '{"modelId":"m2","displayName":"M2"}]');
expect('a repeated model or effort id is reported',
  (() => {
    const duplicateModel = draft();
    duplicateModel.setModelRows('models',
      [new RuntimeModelRow('m1', 'M1', []), new RuntimeModelRow('m1', 'Other', [])]);
    const duplicateEffort = draft();
    duplicateEffort.setModelRows('models', [new RuntimeModelRow('m1', 'M1',
      [new RuntimeEffortRow('low', 'Low'), new RuntimeEffortRow('low', 'Again')])]);
    return [outcomeOf(duplicateModel).errors.models, outcomeOf(duplicateEffort).errors.models];
  })(),
  ['app.string.runtime_config_duplicate_model', 'app.string.runtime_config_duplicate_effort']);
expect('a JSON field is parsed, an empty one is dropped and a broken one is reported',
  (() => {
    const active = draft();
    active.setText('payload', '{"a":1}');
    const parsed = outcomeOf(active);
    active.setText('payload', '   ');
    const blank = outcomeOf(active);
    active.setText('payload', '{oops');
    const broken = outcomeOf(active);
    return [
      JSON.stringify(parsed.config.payload), 'payload' in blank.config,
      'payload' in broken.config, broken.errors.payload,
    ];
  })(),
  ['{"a":1}', false, false, 'app.string.runtime_config_invalid_json']);
expect('a saved environment object and model list are read back for editing',
  (() => {
    const active = draft({
      env: { B: '2', A: '1', C: null },
      models: [{ modelId: 'm', displayName: 'M', efforts: [{ effortId: 'e', displayName: 'E' }] }],
    });
    const rows = active.envRows('env');
    const models = active.modelRows('models');
    return [
      rows.map((row) => row.key), rows.map((row) => row.value),
      rows.map((row) => row.removesInherited),
      models.map((row) => [row.modelId, row.displayName, row.efforts.map((e) => [e.effortId, e.displayName])]),
    ];
  })(),
  [['A', 'B', 'C'], ['1', '2', ''], [false, false, true], [['m', 'M', [['e', 'E']]]]]);
expect('resetDefaults restores the descriptor defaults and keeps the named-instance values',
  (() => {
    const active = draft();
    active.setText('apiKey', 'edited');
    active.setText('count', '7');
    active.setBoolean('alpha', true);
    active.resetDefaults();
    return [active.text('apiKey'), active.boolean('alpha'), active.text('zeta'),
      active.text('count'), outcomeOf(active).config.apiKey];
  })(),
  ['dflt', false, 'z', '', 'dflt']);

// ---------------------------------------------------------------- validation

/** One field per validation rule the schema check implements. */
const RULES_SCHEMA = {
  type: 'object',
  properties: {
    slug: { type: 'string', pattern: '^[a-z]+$' },
    long: { type: 'string', maxLength: 3 },
    pick: { anyOf: [{ type: 'string', minLength: 2 }, { type: 'number' }] },
    only: { oneOf: [{ type: 'number', minimum: 0 }, { type: 'integer' }] },
    tags: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } },
    nested: { type: 'object', required: ['x'], properties: { x: { type: 'string' } } },
    strict: { type: 'object', additionalProperties: false, properties: {} },
    num: { type: 'number', minimum: 5 },
  },
};

function rulesDraft() {
  return RuntimeConfigDraft.create(RULES_SCHEMA, null, {}, null, false);
}

expect('every schema rule reports its own message, field by field',
  (() => {
    const active = rulesDraft();
    active.setText('slug', 'ABC');
    active.setText('long', 'abcd');
    active.setText('pick', '"x"');
    active.setText('only', '5');
    active.setText('tags', '["a","a"]');
    active.setText('nested', '{}');
    active.setEnvRows('strict', [new RuntimeEnvRow('ANY', '1')]);
    active.setText('num', '3');
    return Object.fromEntries([...active.makeConfig().errors].sort());
  })(),
  {
    long: 'app.string.runtime_config_value_too_long',
    nested: 'app.string.runtime_config_incomplete_group',
    num: 'app.string.runtime_config_out_of_range',
    only: UNSUPPORTED,
    pick: UNSUPPORTED,
    slug: 'app.string.runtime_config_invalid_format',
    strict: 'app.string.runtime_config_unsupported_field',
    tags: 'app.string.runtime_config_duplicate_items',
  });
expect('the same rules accept values that satisfy them',
  (() => {
    const active = rulesDraft();
    active.setText('slug', 'abc');
    active.setText('long', 'abc');
    active.setText('pick', '"xy"');
    active.setText('only', '-5');
    active.setText('tags', '["a"]');
    active.setText('nested', '{"x":"1"}');
    active.setText('num', '5');
    const outcome = active.makeConfig();
    return [Object.keys(outcome.errors), outcome.config.only, outcome.config.tags,
      outcome.config.num, JSON.stringify(outcome.config.nested)];
  })(),
  [[], -5, ['a'], 5, '{"x":"1"}']);

finish();
