/**
 * Connector and runtime DTO parsing - every default the wire contract promises.
 *
 * These parsers are the only place a Server reply becomes an app object, so each
 * fallback in them is user-visible: a nameless connector becomes "Device", a
 * missing status becomes "offline" (the device reads as offline rather than
 * throwing), an unknown runtime state becomes "unknown" so a newer Server cannot
 * break the list, and a blank `name` becomes `undefined` rather than an empty
 * label. `runtimeTypeCanAdd` is the other half: the rule that decides whether the
 * add sheet offers a runtime type at all, including the cleared-instance case
 * that lets a removed runtime be configured again.
 *
 * Every value below comes from the real `api/DevicesDtos.ets` through the harness
 * mirror; nothing is re-implemented here.
 */
import { loadModule, suite, expect, finish } from './lib.mjs';

const dtos = await loadModule('api/DevicesDtos.ets');
const { DeviceRuntimeStatus } = dtos;

suite('api/DevicesDtos.ets');

/** The thrown error's name and message, or null when nothing was thrown. */
function thrownBy(call) {
  try {
    call();
    return null;
  } catch (error) {
    return { name: error.name, message: error.message };
  }
}

// ------------------------------------------------------------------ devices

const device = dtos.parseRemoteDevice({
  id: 'd1', name: 'Phone', deviceOs: 'HarmonyOS', status: 'online',
  lastSeenAt: '2026-01-01T10:00:00Z', createdAt: '2025-12-01T00:00:00Z',
});
expect('a device is mapped field for field', device, {
  id: 'd1', name: 'Phone', deviceOs: 'HarmonyOS', online: true,
  lastSeenAt: '2026-01-01T10:00:00Z', createdAt: '2025-12-01T00:00:00Z',
});
expect('a nameless device falls back to the generic name',
  [undefined, '', null].map((name) => dtos.parseRemoteDevice({ id: 'd1', name: name }).name),
  ['Device', 'Device', 'Device']);
expect('online is derived from the exact status word, and offline is the default',
  [
    dtos.parseRemoteDevice({ id: 'd1', status: 'online' }).online,
    dtos.parseRemoteDevice({ id: 'd1', status: 'unavailable' }).online,
    dtos.parseRemoteDevice({ id: 'd1', status: 'ONLINE' }).online,
    dtos.parseRemoteDevice({ id: 'd1' }).online,
    dtos.parseRemoteDevice({ id: 'd1', status: '' }).online,
  ],
  [true, false, false, false, false]);
expect('the optional strings collapse to null when absent or blank',
  [dtos.parseRemoteDevice({ id: 'd1', deviceOs: '', lastSeenAt: '' }).deviceOs,
    dtos.parseRemoteDevice({ id: 'd1' }).lastSeenAt,
    dtos.parseRemoteDevice({ id: 'd1' }).createdAt],
  [null, null, null]);
expect('a missing id is a contract break, not a silent default',
  thrownBy(() => dtos.parseRemoteDevice({ name: 'Phone' })),
  { name: 'AAResponseFormatError', message: 'The server response is missing "id".' });

expect('a list reply tolerates every absent shape and parses what is there',
  [
    dtos.parseRemoteDeviceList({}).length,
    dtos.parseRemoteDeviceList({ connectors: null }).length,
    dtos.parseRemoteDeviceList({ connectors: 'nope' }).length,
    dtos.parseRemoteDeviceList({ connectors: [{ id: 'a' }, { id: 'b' }] }).map((d) => d.id),
  ],
  [0, 0, 0, ['a', 'b']]);
expect('the single-connector envelope unwraps the connector',
  dtos.parseRemoteDeviceEnvelope({ connector: { id: 'a', name: 'Laptop' } }),
  { id: 'a', name: 'Laptop', deviceOs: null, online: false, lastSeenAt: null, createdAt: null });
expect('an envelope without a connector is a contract break',
  thrownBy(() => dtos.parseRemoteDeviceEnvelope({})),
  { name: 'AAResponseFormatError', message: 'The server response is missing "connector".' });

// ---------------------------------------------------------------- statuses

expect('the wire status words are spelled exactly as the Server sends them',
  [DeviceRuntimeStatus.STOPPED, DeviceRuntimeStatus.DISCOVERING, DeviceRuntimeStatus.AVAILABLE,
    DeviceRuntimeStatus.UNAVAILABLE, DeviceRuntimeStatus.VALIDATING, DeviceRuntimeStatus.STARTING,
    DeviceRuntimeStatus.RUNNING, DeviceRuntimeStatus.STOPPING, DeviceRuntimeStatus.ERROR,
    DeviceRuntimeStatus.UNKNOWN],
  ['stopped', 'discovering', 'available', 'unavailable', 'validating', 'starting',
    'running', 'stopping', 'error', 'unknown']);
expect('an unknown state becomes unknown instead of breaking the list',
  [
    dtos.parseDeviceRuntimeStatus('RUNNING'),
    dtos.parseDeviceRuntimeStatus('Error'),
    dtos.parseDeviceRuntimeStatus('bogus'),
    dtos.parseDeviceRuntimeStatus(''),
    dtos.parseDeviceRuntimeStatus(undefined),
    dtos.parseDeviceRuntimeStatus('available'),
  ],
  ['running', 'error', 'unknown', 'unknown', 'unknown', 'available']);

// ----------------------------------------------------------------- runtimes

const runtime = dtos.parseRemoteDeviceRuntime({
  runtimeId: 'rt1', runtimeType: 'codex', displayName: 'Work', status: 'RUNNING',
  typeDisplayName: 'Codex', name: 'Work', present: true, configured: false, active: true,
}, 'c-fallback');
expect('a runtime falls back to the requested connector id',
  [runtime.connectorId, runtime.id, runtime.type, runtime.displayName, runtime.status],
  ['c-fallback', 'rt1', 'codex', 'Work', 'running']);
expect('a blank instance name is absent, not an empty label',
  [
    [runtime.typeDisplayName, runtime.name],
    [dtos.parseRemoteDeviceRuntime({}, 'c').typeDisplayName,
      dtos.parseRemoteDeviceRuntime({}, 'c').name],
    [dtos.parseRemoteDeviceRuntime({ name: '', typeDisplayName: '' }, 'c').name,
      dtos.parseRemoteDeviceRuntime({ name: '', typeDisplayName: '' }, 'c').typeDisplayName],
  ],
  [['Codex', 'Work'], [null, null], [null, null]]);
expect('present, configured and active are true only when the Server said true',
  (() => {
    const strict = dtos.parseRemoteDeviceRuntime(
      { present: 'true', configured: 1, active: true }, 'c');
    return [strict.present, strict.configured, strict.active];
  })(),
  [false, false, true]);
expect('the object fields default to an empty object and the optional ones to null',
  [JSON.stringify(runtime.discovery), JSON.stringify(runtime.metadata),
    JSON.stringify(runtime.uiSchema), JSON.stringify(runtime.defaults),
    runtime.schema, runtime.config, runtime.error],
  ['{}', '{}', '{}', '{}', null, null, null]);
expect('a runtime without a state or timestamps reads as unknown and null',
  (() => {
    const bare = dtos.parseRemoteDeviceRuntime({ status: 'bogus', lastDiscoveredAt: '', updatedAt: '' }, 'c');
    return [bare.status, bare.lastDiscoveredAt, bare.updatedAt, bare.id, bare.type, bare.displayName];
  })(),
  ['unknown', null, null, '', '', '']);

const inventory = dtos.parseRemoteDeviceRuntimeList(
  { runtimes: [{ runtimeId: 'rt1', runtimeType: 'codex' }] }, 'c-fallback');
expect('an inventory reply prefers its own connector id and falls back when it omits one',
  [
    dims(dtos.parseRemoteDeviceRuntimeList({ connectorId: 'c-reply' }, 'c-fallback')),
    dims(dtos.parseRemoteDeviceRuntimeList({ connectorId: '  ' }, 'c-fallback')),
    dims(inventory),
  ],
  [['c-reply', 0, null], ['  ', 0, null], ['c-fallback', 1, null]]);

function dims(list) {
  return [list.connectorId, list.runtimes.length, list.serverTime];
}

// ------------------------------------------------------------- runtime types

const types = dtos.parseRemoteRuntimeTypeList({
  connectorId: 'c1',
  runtimeTypes: [
    {
      runtimeType: 'codex', displayName: 'Codex', present: true,
      configSchema: { schema: { properties: { a: {} } }, uiSchema: { order: ['a'] }, defaults: { a: 1 } },
      schema: { properties: { b: {} } }, uiSchema: { order: ['b'] }, defaults: { b: 2 },
    },
    {
      runtimeType: 'claude', displayName: 'Claude', present: true, configSchema: {},
      schema: { properties: { c: {} } }, defaults: { c: 3 },
    },
  ],
}, 'c-fallback');
expect('the nested config schema wins over the top-level copy',
  [JSON.stringify(types.runtimeTypes[0].schema), JSON.stringify(types.runtimeTypes[0].uiSchema),
    JSON.stringify(types.runtimeTypes[0].defaults)],
  ['{"properties":{"a":{}}}', '{"order":["a"]}', '{"a":1}']);
expect('an empty descriptor falls back field by field to the top-level copy',
  [JSON.stringify(types.runtimeTypes[1].schema), types.runtimeTypes[1].uiSchema,
    JSON.stringify(types.runtimeTypes[1].defaults), types.runtimeTypes[1].instancePolicy,
    types.runtimeTypes[1].maxInstances, types.runtimeTypes[1].recommendationRank,
    types.runtimeTypes[1].description, types.runtimeTypes[1].connectorId],
  ['{"properties":{"c":{}}}', null, '{"c":3}', 'single', null, null, null, 'c-fallback']);

// -------------------------------------------------------------- canAdd rule

function makeType(patch) {
  return dtos.parseRemoteRuntimeTypeList({
    runtimeTypes: [Object.assign({
      runtimeType: 'codex', displayName: 'Codex', present: true,
      schema: { type: 'object', properties: {} },
    }, patch)],
  }, 'c').runtimeTypes[0];
}

function makeInstances(entries) {
  return dtos.parseRemoteDeviceRuntimeList({ runtimes: entries }, 'c').runtimes;
}

const twoCodex = makeInstances([
  { runtimeId: 'a', runtimeType: 'codex', configured: true },
  { runtimeId: 'b', runtimeType: 'codex', configured: true },
]);
expect('a type that is absent or has no schema cannot be added',
  [
    dtos.runtimeTypeCanAdd(makeType({ present: false }), []),
    dtos.runtimeTypeCanAdd(makeType({ schema: null }), []),
  ],
  [false, false]);
expect('a single-instance type is offered until one instance exists',
  [
    dtos.runtimeTypeCanAdd(makeType({}), []),
    dtos.runtimeTypeCanAdd(makeType({}), makeInstances([{ runtimeType: 'codex', configured: true }])),
    dtos.runtimeTypeCanAdd(makeType({}), makeInstances([{ runtimeType: 'claude', configured: true }])),
  ],
  [true, false, true]);
expect('a cleared instance makes its type addable again',
  [
    dtos.runtimeTypeCanAdd(makeType({}), makeInstances([{ runtimeType: 'codex', configured: false }])),
    dtos.runtimeTypeCanAdd(makeType({ instancePolicy: 'multiple', maxInstances: 1 }),
      makeInstances([{ runtimeType: 'codex', configured: true }, { runtimeType: 'codex', configured: false }])),
  ],
  [true, true]);
expect('a multiple-instance type respects its limit, and no limit means no limit',
  [
    dtos.runtimeTypeCanAdd(makeType({ instancePolicy: 'multiple', maxInstances: 2 }), twoCodex),
    dtos.runtimeTypeCanAdd(makeType({ instancePolicy: 'multiple', maxInstances: 2 }),
      makeInstances([{ runtimeType: 'codex', configured: true }])),
    dtos.runtimeTypeCanAdd(makeType({ instancePolicy: 'multiple' }), twoCodex),
    dtos.runtimeTypeCanAdd(makeType({ instancePolicy: 'weird' }), twoCodex),
  ],
  [false, true, true, false]);

finish();
