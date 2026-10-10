/**
 * The composer's placeholder rule table — and the branch this port was missing.
 *
 * `placeholder()` is a table of guards, not a computation, so this is a
 * structural check: it extracts the branch order from the real source and
 * compares it with Android's order (`SessionDetailScreen.kt:1541-1561`). The bug
 * it guards was a *missing* branch — the port had no `inputEnabled -> reply hint`
 * case, so a finished session fell through to "this runtime state cannot send",
 * which the user hit as a wrong refusal on a perfectly writable composer.
 */
import { readSource, expect, suite, finish } from './lib.mjs';

const source = readSource('ui/screens/sessiondetail/SessionDetailScreen.ets');
const start = source.indexOf('private placeholder(): ResourceStr {');
if (start < 0) {
  throw new Error('placeholder() not found');
}
const body = source.slice(start, source.indexOf('\n  }', start));

// Each branch: its guard and the resource it returns, in source order. The
// argument may itself contain parentheses (`this.runtimeLabel()`), so it is taken
// up to the closing `);` rather than with a bracket-negating class.
const branches = [];
const branchRe = /if \((.+?)\) \{\s*return \$r\('app\.string\.(\w+)'([^;]*)\);/g;
let match;
while ((match = branchRe.exec(body)) !== null) {
  branches.push({ guard: match[1].trim(), resource: match[2], arg: (match[3] || '').trim() });
}
// The fallthrough sits at method level (4 spaces); every branch's return is one
// level deeper, so the indentation separates them.
const fallthrough = /\n {4}return \$r\('app\.string\.(\w+)'\)/.exec(body);
const order = branches.map((b) => b.resource).concat(fallthrough ? [fallthrough[1]] : []);

// Android's order, translated to this port's resource names. `Disconnected` and
// the runtime error message are not ported yet; the rest must match exactly.
const ANDROID = [
  'session_read_only_placeholder',
  'session_device_offline_placeholder',
  'session_waiting_approval_placeholder',
  'session_runtime_state_error',
  'session_pending_placeholder',
  'session_busy_placeholder',
  'session_waiting_approval_placeholder',
  'session_error_placeholder',
  'session_reply_to',
  'session_send_unavailable',
];

suite('SessionDetailScreen.placeholder()');

expect('branch count matches Android', order.length, ANDROID.length);
expect('branch order and resources match Android', order, ANDROID);
expect('a writable composer gets the reply hint',
  order[order.length - 2], 'session_reply_to');
expect('the fallthrough is the refusal',
  order[order.length - 1], 'session_send_unavailable');

const reply = branches.find((b) => b.resource === 'session_reply_to');
expect('the reply hint is guarded by inputEnabled()',
  reply !== undefined ? reply.guard : null, 'this.inputEnabled()');
expect('the reply hint carries the runtime label as its argument',
  reply !== undefined && reply.arg.length > 0, true);

finish();
