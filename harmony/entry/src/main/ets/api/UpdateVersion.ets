/**
 * Update version comparison.
 *
 * Port of `api/UpdateVersion.kt`.
 *
 * Release names are compared segment by segment, and a pre-release suffix ranks
 * *below* the release it leads to (`1.2.0-rc1 < 1.2.0`). Android uses
 * `BigInteger` for the numeric pieces because a Server may send a segment of any
 * length; this port compares the digit strings directly — strip leading zeros,
 * then longer wins, then lexicographic — which is the same ordering for
 * non-negative integers and needs no big-number type.
 */

interface UpdateVersion {
  release: string[];
  pre: string[];
}

const VERSION_PATTERN: RegExp =
  /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)|((?:a|b|rc|dev)\d+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseUpdateVersion(value: string): UpdateVersion | null {
  const trimmed: string = value.trim();
  if (trimmed.length > 128) {
    return null;
  }
  const match: RegExpMatchArray | null = trimmed.match(VERSION_PATTERN);
  if (match === null) {
    return null;
  }
  // `1.2.0rc1` keeps its suffix attached; a dash-separated one does not.
  let suffix: string = match[2] === undefined ? '' : match[2];
  if (suffix.length === 0 && match[3] !== undefined) {
    suffix = match[3].replace(/(\D+)(\d+)$/, '$1.$2');
  }
  return {
    release: match[1].split('.'),
    pre: suffix.length > 0 ? suffix.split('.') : [],
  };
}

/** Compares two non-negative integer strings of any length. */
function compareNumericStrings(left: string, right: string): number {
  const a: string = left.replace(/^0+(?=\d)/, '');
  const b: string = right.replace(/^0+(?=\d)/, '');
  if (a.length !== b.length) {
    return a.length < b.length ? -1 : 1;
  }
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function allDigits(value: string): boolean {
  return /^\d+$/.test(value);
}

/** `-1`, `0` or `1`, or `null` when either name is not a version. */
export function compareUpdateVersions(left: string, right: string): number | null {
  const a: UpdateVersion | null = parseUpdateVersion(left);
  const b: UpdateVersion | null = parseUpdateVersion(right);
  if (a === null || b === null) {
    return null;
  }
  const segments: number = Math.max(a.release.length, b.release.length);
  for (let index = 0; index < segments; index++) {
    const x: string = index < a.release.length ? a.release[index] : '0';
    const y: string = index < b.release.length ? b.release[index] : '0';
    const compared: number = compareNumericStrings(x, y);
    if (compared !== 0) {
      return compared;
    }
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    if (a.pre.length > 0) {
      return -1;
    }
    return b.pre.length > 0 ? 1 : 0;
  }
  const parts: number = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < parts; index++) {
    if (index >= a.pre.length) {
      return -1;
    }
    if (index >= b.pre.length) {
      return 1;
    }
    const x: string = a.pre[index];
    const y: string = b.pre[index];
    if (x === y) {
      continue;
    }
    const xn: boolean = allDigits(x);
    const yn: boolean = allDigits(y);
    let compared: number;
    if (xn && yn) {
      compared = compareNumericStrings(x, y);
    } else if (xn !== yn) {
      compared = xn ? -1 : 1;
    } else {
      compared = x < y ? -1 : 1;
    }
    if (compared !== 0) {
      return compared;
    }
  }
  return 0;
}
