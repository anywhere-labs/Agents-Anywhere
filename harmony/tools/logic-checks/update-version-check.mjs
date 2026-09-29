/**
 * Update version comparison - which release the update banner calls newer.
 *
 * The rule is semver-shaped, but the parts a user notices are the ones a naive
 * port gets wrong: a pre-release must rank *below* the release it leads to, a
 * numeric segment must be compared as an integer (so 1.10 is not 1.1), and a
 * segment of any length must survive without a 64-bit float in the middle
 * (`BigInteger` on Android; digit-string comparison here).
 *
 * Every comparison below is made by the real `compareUpdateVersions` from
 * `api/UpdateVersion.ets`; a `null` means "not a version", which is the third
 * outcome the caller distinguishes.
 */
import { loadModule, suite, expect, finish } from './lib.mjs';

const { compareUpdateVersions } = await loadModule('api/UpdateVersion.ets');

suite('api/UpdateVersion.ets');

// ------------------------------------------------------------ equal versions

expect('identical names compare equal', compareUpdateVersions('1.2.3', '1.2.3'), 0);
expect('the leading v and surrounding space are decoration',
  [compareUpdateVersions('v1.2.3', '1.2.3'), compareUpdateVersions(' 1.2.3 ', '1.2.3')], [0, 0]);
expect('a missing trailing segment counts as zero',
  [compareUpdateVersions('1.2', '1.2.0'), compareUpdateVersions('1.2.0.0.0', '1.2')], [0, 0]);
expect('leading zeros in a segment are not significant',
  [compareUpdateVersions('1.02', '1.2'), compareUpdateVersions('1.0.0', '1.00.000')], [0, 0]);

// --------------------------------------------------------- numeric segments

expect('a numeric segment is an integer, not text',
  [compareUpdateVersions('1.10.0', '1.9.0'), compareUpdateVersions('1.9.0', '1.10.0')], [1, -1]);
expect('the release numbers decide before anything else',
  [compareUpdateVersions('2.0.0', '1.9.9'), compareUpdateVersions('1.9.9', '2.0.0')], [1, -1]);
expect('segments of any length keep their integer order',
  [
    compareUpdateVersions('1.10000000000000000000', '1.9999999999999999999'),
    compareUpdateVersions('1.9999999999999999999', '1.10000000000000000000'),
    compareUpdateVersions('1.000000000000000000001', '1.1'),
  ],
  [1, -1, 0]);

// -------------------------------------------------------------- pre-releases

expect('a pre-release ranks below the release it leads to',
  [compareUpdateVersions('1.2.0-rc1', '1.2.0'), compareUpdateVersions('1.2.0', '1.2.0-rc1')],
  [-1, 1]);
expect('an attached suffix is the same pre-release as a dash-separated one',
  [compareUpdateVersions('1.2.0rc1', '1.2.0-rc.1'), compareUpdateVersions('1.0.0a1', '1.0.0-a.1')],
  [0, 0]);
expect('alpha pre-releases order among themselves',
  [compareUpdateVersions('1.0.0-alpha', '1.0.0-beta'),
    compareUpdateVersions('1.0.0-rc.1', '1.0.0-rc.2')],
  [-1, -1]);
expect('the pre-release comparison is case-sensitive',
  [compareUpdateVersions('1.0.0-RC.1', '1.0.0-rc.1'), compareUpdateVersions('1.0.0-rc.1', '1.0.0-RC.1')],
  [-1, 1]);
expect('a numeric pre-release identifier ranks below an alphanumeric one',
  [compareUpdateVersions('1.0.0-1', '1.0.0-alpha'),
    compareUpdateVersions('1.0.0-alpha', '1.0.0-1')],
  [-1, 1]);
expect('a shorter pre-release ranks below a longer one with the same prefix',
  [compareUpdateVersions('1.0.0-alpha', '1.0.0-alpha.1'),
    compareUpdateVersions('1.0.0-alpha.1', '1.0.0-alpha')],
  [-1, 1]);
expect('build metadata is ignored', compareUpdateVersions('1.0.0+build.5', '1.0.0'), 0);

// ------------------------------------------------------------ unusable names

expect('a name that is not a version reports null',
  [
    compareUpdateVersions('abc', '1.0.0'),
    compareUpdateVersions('', '1.0.0'),
    compareUpdateVersions('   ', '1.0.0'),
    compareUpdateVersions('1.2.3-', '1.0.0'),
    compareUpdateVersions('1..2', '1.0.0'),
    compareUpdateVersions('v', '1.0.0'),
    compareUpdateVersions('1.0.0 beta', '1.0.0'),
  ],
  [null, null, null, null, null, null, null]);
expect('one unusable name makes the pair unusable',
  [compareUpdateVersions('1.0.0', 'latest'), compareUpdateVersions('latest', 'latest')],
  [null, null]);
expect('a name at the length limit still parses, one past it does not',
  [
    compareUpdateVersions('1' + '.1'.repeat(63), '1' + '.1'.repeat(63)),
    compareUpdateVersions('1' + '.1'.repeat(64), '1' + '.1'.repeat(63)),
  ],
  [0, null]);

// --------------------------------------------------------------- antisymmetry

const pairs = [
  ['1.10.0', '1.9.0'],
  ['1.2.0-rc1', '1.2.0'],
  ['1.0.0-alpha.1', '1.0.0-alpha'],
  ['2.0.0', '1.9.9'],
];
expect('reversing the operands reverses the sign',
  pairs.map((pair) => compareUpdateVersions(pair[0], pair[1])
    + compareUpdateVersions(pair[1], pair[0])),
  pairs.map(() => 0));

finish();
