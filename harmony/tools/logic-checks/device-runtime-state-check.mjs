/**
 * Device runtime list management - the state the device detail page renders.
 *
 * Two user-visible rules live here and both are easy to break with a one-token
 * edit: the fixed rank order of the rows (Codex, Claude, DSH, then the rest by
 * name) and the "only one operation at a time" rule that disables every row's
 * controls. The rest of the module is the pure list algebra behind that page:
 * filtering configured vs discovered instances, folding an inventory reply in,
 * folding one activation reply in, and the small readers the add sheet uses.
 *
 * Every value below comes from the real `DeviceRuntimeState.ets` through the
 * harness mirror; nothing is re-implemented here.
 */
import { loadModule, suite, expect, finish } from './lib.mjs';

const runtimeState = await loadModule('feature/devices/DeviceRuntimeState.ets');
const { DeviceRuntimeStatus } = await loadModule('api/DevicesDtos.ets');
const { DeviceRuntimeManagementState } = runtimeState;

suite('feature/devices/DeviceRuntimeState.ets');

/** One inventory entry, shaped exactly like the Server's parsed instance. */
function makeRuntime(id, type, displayName, patch) {
  return Object.assign({
    connectorId: 'c1',
    id: id,
    type: type,
    displayName: displayName,
    present: true,
    configured: true,
    active: false,
    status: DeviceRuntimeStatus.STOPPED,
    discovery: {},
    metadata: {},
    schema: null,
    uiSchema: {},
    defaults: {},
    config: null,
    error: null,
    lastDiscoveredAt: null,
    updatedAt: null,
  }, patch || {});
}

const codex = makeRuntime('r-codex', 'codex', 'Beta');
const claude = makeRuntime('r-claude', 'claude', 'Alpha');
const dsh = makeRuntime('r-dsh', 'dsh', 'Zeta');
const otherA = makeRuntime('r-aaa', 'gemini', 'aaa');
const otherZ = makeRuntime('r-zzz', 'gemini', 'ZZZ');
const clearedCodex = makeRuntime('r-cleared', 'codex', 'Cleared', { configured: false });
const absentGemini = makeRuntime('r-absent', 'gemini', 'Absent', { present: false, configured: false });

// ------------------------------------------------------------- row ordering

expect('the rank order is codex, claude, dsh, then everything else',
  [
    runtimeState.compareDeviceRuntimes(codex, claude) < 0,
    runtimeState.compareDeviceRuntimes(claude, dsh) < 0,
    runtimeState.compareDeviceRuntimes(dsh, otherA) < 0,
    runtimeState.compareDeviceRuntimes(makeRuntime('x', 'codex', 'zzz'),
      makeRuntime('y', 'claude', 'aaa')) < 0,
  ],
  [true, true, true, true]);
expect('two unknown types order by lower-cased name',
  runtimeState.compareDeviceRuntimes(otherA, otherZ), -1);
expect('the name comparison ignores case',
  runtimeState.compareDeviceRuntimes(makeRuntime('x', 'dsh', 'Beta'),
    makeRuntime('y', 'dsh', 'alpha')), 1);
expect('names that differ only in case compare equal',
  runtimeState.compareDeviceRuntimes(makeRuntime('x', 'dsh', 'Codex'),
    makeRuntime('y', 'dsh', 'codex')), 0);

// ---------------------------------------------------- configured / discovered

const inventory = [otherZ, dsh, claude, codex, otherA, clearedCodex, absentGemini];
const inventoryOrder = inventory.map((runtime) => runtime.id);
const page = new DeviceRuntimeManagementState('c1', inventory, false, false, null, null, false);

expect('configured rows are filtered, ranked and name-sorted',
  page.configuredRuntimes().map((runtime) => runtime.id),
  ['r-codex', 'r-claude', 'r-dsh', 'r-aaa', 'r-zzz']);
expect('the state keeps the inventory it was given, unsorted',
  inventory.map((runtime) => runtime.id), inventoryOrder);
expect('discovery lists the present rows that are not configured yet',
  page.discoveredUnconfiguredRuntimes().map((runtime) => runtime.id),
  ['r-cleared']);

// ------------------------------------------------------------- constructors

const empty = DeviceRuntimeManagementState.empty();
const loading = DeviceRuntimeManagementState.loadingFor('c9');
expect('empty() and loadingFor() are the two pages before the first reply',
  [
    empty.connectorId, empty.runtimes.length, empty.loading, empty.discovering,
    empty.pendingRuntimeId, empty.errorMessage, empty.errorFromDiscovery,
    loading.connectorId, loading.loading, loading.runtimes.length,
  ],
  [null, 0, false, false, null, null, false, 'c9', true, 0]);

// ---------------------------------------------------------- copy semantics

const base = empty.copy({ connectorId: 'c1' });
const cleared = base.copy({
  connectorId: null, pendingRuntimeId: null, errorMessage: null, errorFromDiscovery: false,
});
expect('copy applies an explicit null and an explicit false',
  [cleared.connectorId, cleared.pendingRuntimeId, cleared.errorMessage, cleared.errorFromDiscovery],
  [null, null, null, false]);
const untouched = base.copy({ runtimes: undefined, loading: true });
expect('copy keeps the fields a patch leaves out',
  [untouched.connectorId, untouched.runtimes.length, untouched.loading], ['c1', 0, true]);

// ------------------------------------------------------- applying replies

const reply = [otherZ, codex, dsh];
const applied = page.copy({ loading: true, discovering: true, pendingRuntimeId: 'r-zzz', errorMessage: 'stale' })
  .replaceWithList({ connectorId: 'c2', runtimes: reply, serverTime: null });
expect('replaceWithList ranks the whole inventory',
  applied.runtimes.map((runtime) => runtime.id), ['r-codex', 'r-dsh', 'r-zzz']);
expect('replaceWithList clears every in-flight marker',
  [applied.connectorId, applied.loading, applied.discovering,
    applied.pendingRuntimeId, applied.errorMessage, applied.errorFromDiscovery],
  ['c2', false, false, null, null, false]);
expect('replaceWithList sorts a copy, not the reply it was handed',
  reply.map((runtime) => runtime.id), ['r-zzz', 'r-codex', 'r-dsh']);

const activated = new DeviceRuntimeManagementState('c1', inventory, true, true, 'r-codex', 'boom', true)
  .replaceRuntime(makeRuntime('r-codex', 'codex', 'Beta', { connectorId: 'c3' }));
expect('replaceRuntime swaps the instance instead of duplicating it',
  activated.runtimes.filter((runtime) => runtime.id === 'r-codex').length, 1);
expect('replaceRuntime re-ranks and clears the finished operation',
  [activated.runtimes[0].id, activated.connectorId, activated.pendingRuntimeId,
    activated.errorMessage, activated.errorFromDiscovery],
  ['r-codex', 'c3', null, null, false]);
expect('replaceRuntime leaves the list-level flags alone',
  [activated.loading, activated.discovering], [true, true]);
expect('replaceRuntime appends an instance the list did not have',
  page.replaceRuntime(makeRuntime('r-new', 'gemini', 'New'))
    .runtimes.map((runtime) => runtime.id),
  ['r-codex', 'r-cleared', 'r-claude', 'r-dsh', 'r-aaa', 'r-absent', 'r-new', 'r-zzz']);

// ------------------------------------------------------------ row behaviour

const busy = page.copy({ discovering: true });
expect('an in-flight operation disables every row',
  [page.copy({ pendingRuntimeId: 'r-codex' }).operationsEnabled(),
    busy.operationsEnabled(), loading.copy({ loading: false }).operationsEnabled()],
  [false, false, true]);
expect('a runtime can be activated only when present and configured',
  [runtimeState.runtimeCanActivate(codex), runtimeState.runtimeCanActivate(clearedCodex),
    runtimeState.runtimeCanActivate(absentGemini)],
  [true, false, false]);
const failed = busy.discoveryFailed('probe failed');
expect('discoveryFailed stops discovery and tags the error as a discovery one',
  [failed.discovering, failed.errorMessage, failed.errorFromDiscovery, failed.connectorId],
  [false, 'probe failed', true, 'c1']);

// ------------------------------------------------------------ the small readers

expect('reconfigurableRuntime finds the first cleared instance of that type',
  [
    runtimeState.reconfigurableRuntime(inventory, 'codex').id,
    runtimeState.reconfigurableRuntime(
      [makeRuntime('r1', 'codex', 'one', { configured: false }),
        makeRuntime('r2', 'codex', 'two', { configured: false })], 'codex').id,
    runtimeState.reconfigurableRuntime([codex, claude], 'dsh'),
  ],
  ['r-cleared', 'r1', null]);
expect('runtimeNamed matches exactly and configuredRuntime reads the configured one',
  [
    runtimeState.runtimeNamed(inventory, 'gemini', 'aaa').id,
    runtimeState.runtimeNamed(inventory, 'gemini', 'AAA'),
    runtimeState.configuredRuntime(inventory, 'codex').id,
    runtimeState.configuredRuntime(inventory, 'claude').id,
    runtimeState.configuredRuntime(inventory, 'llama'),
  ],
  ['r-aaa', null, 'r-codex', 'r-claude', null]);
expect('runtimeIsUp wants a configured, active instance in a live state',
  [
    runtimeState.runtimeIsUp(makeRuntime('a', 'codex', 'a', { active: true, status: DeviceRuntimeStatus.RUNNING })),
    runtimeState.runtimeIsUp(makeRuntime('b', 'codex', 'b', { active: true, status: DeviceRuntimeStatus.STARTING })),
    runtimeState.runtimeIsUp(makeRuntime('c', 'codex', 'c', { active: true, status: DeviceRuntimeStatus.STOPPING })),
    runtimeState.runtimeIsUp(makeRuntime('d', 'codex', 'd', { active: true, status: DeviceRuntimeStatus.ERROR })),
    runtimeState.runtimeIsUp(makeRuntime('e', 'codex', 'e', { active: false, status: DeviceRuntimeStatus.RUNNING })),
    runtimeState.runtimeIsUp(makeRuntime('f', 'codex', 'f', { configured: false, active: true, status: DeviceRuntimeStatus.RUNNING })),
  ],
  [true, true, false, false, false, false]);

finish();
