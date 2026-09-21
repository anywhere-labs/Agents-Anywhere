/**
 * The new-session page's runtime inventory — what it may offer, and when the
 * list is settled.
 *
 * Two rules a user notices directly. `activeNewSessionRuntimes` decides whether
 * the page offers a runtime at all, so dropping any one of its three guards
 * offers a runtime whose session the Server would refuse; and
 * `newSessionInventoryNeedsSettling` decides whether the page asks again, so a
 * runtime still coming up must keep the list unsettled instead of being offered
 * in a state that cannot host a session yet.
 *
 * The two orderings are pinned as well: the list is sorted by the *lowercased*
 * display name, and an equal name falls back to the id, which is what keeps two
 * instances of one runtime type from swapping places between refreshes.
 */
import { loadModule, suite, expect, finish } from './lib.mjs';

const inventory = await loadModule('feature/sessions/NewSessionRuntimeInventory.ets');
suite('feature/sessions/NewSessionRuntimeInventory.ets');

/** A runtime as `api/DevicesDtos` parses it; only the fields the rule reads. */
function runtime(id, displayName, status, overrides = {}) {
  return {
    connectorId: 'c1',
    id: id,
    type: 'codex',
    displayName: displayName,
    present: true,
    configured: true,
    active: true,
    status: status,
    ...overrides,
  };
}

const ids = (runtimes) => runtimes.map((entry) => entry.id);

// ------------------------------------------------ activeNewSessionRuntimes

expect('a configured, switched-on, running runtime is offered',
  ids(inventory.activeNewSessionRuntimes([runtime('r1', 'Codex', 'running')])), ['r1']);

expect('a runtime that is only starting is not offered',
  ids(inventory.activeNewSessionRuntimes([runtime('r1', 'Codex', 'starting')])), []);

expect('the status comparison is exact, so an uppercase RUNNING is not offered',
  ids(inventory.activeNewSessionRuntimes([runtime('r1', 'Codex', 'RUNNING')])), []);

expect('a runtime that is not configured is not offered',
  ids(inventory.activeNewSessionRuntimes([runtime('r1', 'Codex', 'running', { configured: false })])), []);

expect('a runtime that is switched off is not offered',
  ids(inventory.activeNewSessionRuntimes([runtime('r1', 'Codex', 'running', { active: false })])), []);

expect('present is not one of the guards, so a runtime that is not present is still offered',
  ids(inventory.activeNewSessionRuntimes([runtime('r1', 'Codex', 'running', { present: false })])), ['r1']);

expect('offered runtimes are ordered by lowercased display name',
  ids(inventory.activeNewSessionRuntimes([
    runtime('r2', 'Banana', 'running'),
    runtime('r1', 'apple', 'running'),
  ])), ['r1', 'r2']);

expect('equal display names fall back to the id ascending',
  ids(inventory.activeNewSessionRuntimes([
    runtime('b', 'Same', 'running'),
    runtime('a', 'same', 'running'),
  ])), ['a', 'b']);

expect('a pair equal in name and id compares equal, so the order is stable',
  ids(inventory.activeNewSessionRuntimes([
    runtime('same', 'Same', 'running'),
    runtime('same', 'Same', 'running'),
  ])), ['same', 'same']);

expect('the caller\'s array is not reordered',
  (() => {
    const input = [runtime('r2', 'Beta', 'running'), runtime('r1', 'Alpha', 'running')];
    inventory.activeNewSessionRuntimes(input);
    return ids(input);
  })(), ['r2', 'r1']);

expect('nothing to offer is an empty list',
  ids(inventory.activeNewSessionRuntimes([])), []);

// -------------------------------------------- newSessionInventoryNeedsSettling

expect('an empty inventory still needs settling',
  inventory.newSessionInventoryNeedsSettling([]), true);

expect('an inventory whose switched-on runtimes are all running is settled',
  inventory.newSessionInventoryNeedsSettling([
    runtime('r1', 'Codex', 'running'),
    runtime('r2', 'Claude Code', 'running'),
  ]), false);

expect('a switched-on runtime that is still starting keeps the inventory unsettled',
  inventory.newSessionInventoryNeedsSettling([
    runtime('r1', 'Codex', 'running'),
    runtime('r2', 'Claude Code', 'starting'),
  ]), true);

expect('a runtime that is not switched on does not keep the inventory unsettled',
  inventory.newSessionInventoryNeedsSettling([
    runtime('r1', 'Codex', 'stopped', { active: false }),
    runtime('r2', 'Claude Code', 'starting', { configured: false }),
  ]), false);

expect('an available runtime that has not started yet keeps the inventory unsettled',
  inventory.newSessionInventoryNeedsSettling([runtime('r1', 'Codex', 'available')]), true);

expect('a runtime in error that is switched on keeps the inventory unsettled',
  inventory.newSessionInventoryNeedsSettling([runtime('r1', 'Codex', 'error')]), true);

finish();
