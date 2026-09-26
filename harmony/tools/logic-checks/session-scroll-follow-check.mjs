/**
 * Auto-follow decisions for the conversation list.
 *
 * These three predicates are the whole of the scroll decision, and each one has a
 * failure a user notices immediately: a wrong auto-follow result either yanks the
 * view away mid-read or stops following a live reply, a wrong
 * `latestTimelineItemChanged` scrolls for a rewrite of an old message, and a
 * wrong `noticesChanged` either misses an approval banner or re-renders on every
 * identical poll. The assertions below pin the truth table for each.
 *
 * `lib.mjs` mirrors the real `.ets`; `lib.mjs` closes the one gap
 * that would otherwise stop this module from loading at all (ArkTS writes its
 * type imports without `import type`, which Node's type stripping then rejects).
 */
import { loadModule, suite, expect, finish } from './lib.mjs';

const follow = await loadModule('feature/sessiondetail/SessionScrollFollow.ets');
suite('feature/sessiondetail/SessionScrollFollow.ets');

const message = (over = {}) => ({ sourceItemId: 'i1', revision: 1, updatedSeq: 1, ...over });
const notice = (over = {}) => ({ noticeId: 'n1', revision: 1, updatedSeq: 1, status: 'open', ...over });

// ------------------------------------------------------------ auto-following

expect('a realtime update follows only when the view is subscribed, unpaused and still',
  follow.shouldAutoFollowRealtime(true, true, false, false), true);
expect('each of the four blocking conditions on its own stops the follow',
  [
    follow.shouldAutoFollowRealtime(false, true, false, false),
    follow.shouldAutoFollowRealtime(true, false, false, false),
    follow.shouldAutoFollowRealtime(true, true, true, false),
    follow.shouldAutoFollowRealtime(true, true, false, true),
  ],
  [false, false, false, false]);
expect('even every permission together cannot follow without an update',
  follow.shouldAutoFollowRealtime(false, true, true, true), false);

// ------------------------------------------------------- latest item changed

expect('an empty history on both sides is not a change', follow.latestTimelineItemChanged([], []), false);
expect('the first message arriving and the history being cleared are both changes',
  [follow.latestTimelineItemChanged([], [message()]), follow.latestTimelineItemChanged([message()], [])],
  [true, true]);
expect('an identical newest item is not a change',
  follow.latestTimelineItemChanged([message()], [message()]), false);
expect('a different newest id is a change',
  follow.latestTimelineItemChanged([message()], [message({ sourceItemId: 'i2' })]), true);
expect('a re-push of the newest item is a change even at the same id',
  [
    follow.latestTimelineItemChanged([message()], [message({ revision: 2 })]),
    follow.latestTimelineItemChanged([message()], [message({ updatedSeq: 2 })]),
  ],
  [true, true]);
expect('a rewrite of an older item does not move the view',
  follow.latestTimelineItemChanged(
    [message(), message({ sourceItemId: 'a' })],
    [message({ revision: 9 }), message({ sourceItemId: 'a' })],
  ), false);
expect('the newest item is still compared when it is not the only one',
  follow.latestTimelineItemChanged(
    [message(), message({ sourceItemId: 'a' })],
    [message(), message({ sourceItemId: 'a', updatedSeq: 2 })],
  ), true);

// ------------------------------------------------------------- notices

expect('an empty notice list on both sides has not changed', follow.noticesChanged([], []), false);
expect('a notice appearing and the list being cleared are both changes',
  [follow.noticesChanged([], [notice()]), follow.noticesChanged([notice()], [])],
  [true, true]);
expect('an identical notice list has not changed',
  follow.noticesChanged([notice(), notice({ noticeId: 'n2' })], [notice(), notice({ noticeId: 'n2' })]), false);
expect('every field a notice can be updated in counts as a change',
  [
    follow.noticesChanged([notice()], [notice({ noticeId: 'n2' })]),
    follow.noticesChanged([notice()], [notice({ revision: 2 })]),
    follow.noticesChanged([notice()], [notice({ updatedSeq: 2 })]),
    follow.noticesChanged([notice()], [notice({ status: 'failed' })]),
  ],
  [true, true, true, true]);
expect('reordering the same notices is a change, because position is compared',
  follow.noticesChanged([notice(), notice({ noticeId: 'n2' })], [notice({ noticeId: 'n2' }), notice()]), true);

finish();
