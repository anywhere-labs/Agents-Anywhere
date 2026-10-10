/**
 * Runtime labels — the rule that named this device's row "DSH".
 *
 * The regression this guards is real: `runtimeInstanceLabels` drops an instance
 * name that equals its runtime type, and "DSH" lowercases to exactly the type
 * "dsh", so the device page showed the type's label instead of the instance's
 * name. `runtimeInstanceName` (iOS's `sessionDisplayName`) exists to avoid that,
 * and these assertions pin both rules so the distinction cannot be lost again.
 */
import { loadModule, suite, expect, finish } from './lib.mjs';

const identity = await loadModule('model/RuntimeIdentity.ets');
suite('model/RuntimeIdentity.ets');

// Type labels: the three known types are spelled out, anything else is
// title-cased the way Kotlin's `replaceFirstChar { titlecase }` does it.
expect('codex type label', identity.runtimeTypeLabel('codex'), 'Codex');
expect('claude type label', identity.runtimeTypeLabel('claude'), 'Claude Code');
expect('dsh type label', identity.runtimeTypeLabel('dsh'), 'DeepSeek Harness');
expect('unknown type is title-cased', identity.runtimeTypeLabel('gemini'), 'Gemini');
expect('empty type stays empty', identity.runtimeTypeLabel(''), '');

// Android's stricter rule: a name that repeats the type is suppressed.
expect('instance name wins over the type label',
  identity.runtimeInstanceLabels('DSH home', 'dsh').primary, 'DSH home');
expect('a name equal to the type falls back to the type label',
  identity.runtimeInstanceLabels('codex', 'codex').primary, 'Codex');
expect('the secondary repeats the type only when the primary differs',
  identity.runtimeInstanceLabels('DSH home', 'dsh').secondary, 'DeepSeek Harness');
expect('the secondary is dropped when it would duplicate the primary',
  identity.runtimeInstanceLabels('Codex', 'codex').secondary, null);
expect('a blank name falls back to the type label',
  identity.runtimeInstanceLabels('   ', 'dsh').primary, 'DeepSeek Harness');

// The abbreviation trap: "DSH" is the *instance's* name for a `dsh` runtime.
expect('an abbreviation of the type is still suppressed by the Android rule',
  identity.runtimeInstanceLabels('DSH', 'dsh').primary, 'DeepSeek Harness');

// iOS's rule keeps it, which is what the device page must show.
expect('iOS rule keeps the instance name', identity.runtimeInstanceName('DSH', 'DSH', 'dsh'), 'DSH');
expect('iOS rule trims', identity.runtimeInstanceName('  DSH  ', '', 'dsh'), 'DSH');
expect('iOS rule falls back to the sent display name',
  identity.runtimeInstanceName('', 'DSH home', 'dsh'), 'DSH home');
expect('iOS rule falls back to the type label when both are blank',
  identity.runtimeInstanceName('', '   ', 'dsh'), 'DeepSeek Harness');
expect('iOS rule tolerates a missing name (older fixtures)',
  identity.runtimeInstanceName(undefined, '', 'claude'), 'Claude Code');
expect('iOS rule tolerates a null name',
  identity.runtimeInstanceName(null, 'Codex', 'codex'), 'Codex');

// The Server's own type display name wins over the built-in table.
expect('sent type display name wins',
  identity.runtimeTypeDisplayName('DeepSeek Harness (local)', 'dsh'),
  'DeepSeek Harness (local)');
expect('blank sent type display name falls back to the table',
  identity.runtimeTypeDisplayName('  ', 'dsh'), 'DeepSeek Harness');
expect('missing sent type display name falls back to the table',
  identity.runtimeTypeDisplayName(undefined, 'codex'), 'Codex');

// The session row's context line joins the two halves with a middot.
expect('context line joins both halves',
  identity.runtimeContextLabel('DSH home', 'dsh'), 'DSH home · DeepSeek Harness');
expect('context line drops a duplicate half',
  identity.runtimeContextLabel('Codex', 'codex'), 'Codex');

finish();
