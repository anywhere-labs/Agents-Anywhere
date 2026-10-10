import { CodeLine, CodeSpan, CodeTokenKind } from '../sessiondetail/CodeTokenizer';

/**
 * In-file search.
 *
 * Port of the search half of `ui/screens/sessiondetail/CodeBlockPreview.kt`.
 *
 * Android hands the query to Sora's `EditorSearcher` with
 * `SearchOptions(caseInsensitive = true, useRegex = false)` and
 * `setCyclicJumping(true)`, then reports `currentMatchedPositionIndex + 1` over
 * `matchedPositionCount`. Sora is not available here, so the scan below does what
 * that search does for a literal query: every non-overlapping occurrence on every
 * line, left to right, compared case-insensitively, with the jump wrapping at
 * both ends.
 *
 * Match offsets are relative to their own line, which is the coordinate the code
 * renderer's token spans use. The highlight colours are the one thing that is not
 * Sora's: they come from this app's palette (`AACodeColors`) instead of the
 * library's built-in defaults, which is recorded in the plan's deviation table.
 */

export interface FileMatch {
  line: number;
  /** Start offset inside the line. */
  start: number;
  /** End offset inside the line, exclusive. */
  end: number;
}

/**
 * Every match of `query` in `lines`.
 *
 * An empty query matches nothing rather than everything, which is what Sora does
 * when the search box is cleared.
 */
export function findFileMatches(lines: string[], query: string): FileMatch[] {
  const needle: string = query.toLowerCase();
  const matches: FileMatch[] = [];
  if (needle.length === 0) {
    return matches;
  }
  for (let index = 0; index < lines.length; index++) {
    const haystack: string = lines[index].toLowerCase();
    if (haystack.length < needle.length) {
      continue;
    }
    let from: number = 0;
    while (from + needle.length <= haystack.length) {
      const at: number = haystack.indexOf(needle, from);
      if (at < 0) {
        break;
      }
      matches.push({ line: index, start: at, end: at + needle.length });
      // Non-overlapping, the way a repeated "find next" walks the text.
      from = at + needle.length;
    }
  }
  return matches;
}

/** Sora's cyclic jumping: the index wraps at both ends. */
export function cycleFileMatch(current: number, total: number, forward: boolean): number {
  if (total <= 0) {
    return -1;
  }
  if (current < 0 || current >= total) {
    return forward ? 0 : total - 1;
  }
  const next: number = forward ? current + 1 : current - 1;
  if (next < 0) {
    return total - 1;
  }
  return next >= total ? 0 : next;
}

/**
 * Android's `"${result.current}/${result.total}"`.
 *
 * Sora reports `current = 0` for an empty result and `1` for a match at index 0,
 * so the label is one-based and reads `0/0` when nothing matched.
 */
export function fileMatchLabel(current: number, total: number): string {
  if (total <= 0 || current < 0) {
    return '0/0';
  }
  return `${current + 1}/${total}`;
}

/** One run of a code line: a token, plus whether a search match covers it. */
export interface CodeRenderSegment {
  text: string;
  kind: CodeTokenKind;
  /** True inside a match, which is what paints the highlight. */
  highlighted: boolean;
  /** True for the match the search is currently on. */
  current: boolean;
}

/**
 * Splits one line's token spans at the search matches inside them.
 *
 * Token colours and search highlights are independent: a match can start in the
 * middle of a keyword and end inside a string, so the rendered segments are the
 * intersections of the two sets in source order. A line with no matches yields
 * its tokens unchanged, which keeps the common case free of extra segments.
 *
 * The scanner leaves the whitespace between tokens out of its spans, so the line
 * is walked as a list of ranges — each span, plus the gaps around them — and every
 * range goes through the same intersection. Without that a rendered line would
 * read `constvalue=0`, and a match covering the space between two tokens would
 * show a hole.
 */
export function codeLineSegments(
  lineIndex: number,
  line: CodeLine,
  matches: FileMatch[],
  currentMatch: number,
): CodeRenderSegment[] {
  const segments: CodeRenderSegment[] = [];
  if (line.text.length === 0) {
    return segments;
  }
  const onLine: FileMatch[] = [];
  const onLineIndex: number[] = [];
  for (let index = 0; index < matches.length; index++) {
    if (matches[index].line === lineIndex) {
      onLine.push(matches[index]);
      onLineIndex.push(index);
    }
  }
  let cursorMatch: number = 0;
  let cursor: number = 0;
  for (let index = 0; index <= line.spans.length; index++) {
    const span: CodeSpan | null = index < line.spans.length ? line.spans[index] : null;
    const gapEnd: number = span === null ? line.text.length : span.start;
    if (gapEnd > cursor) {
      // Whitespace the scanner skipped, rendered as plain text.
      cursorMatch = emitRange(
        segments, line, cursor, gapEnd, CodeTokenKind.Plain,
        onLine, onLineIndex, cursorMatch, currentMatch,
      );
    }
    if (span === null) {
      break;
    }
    cursorMatch = emitRange(
      segments, line, span.start, span.end, span.kind,
      onLine, onLineIndex, cursorMatch, currentMatch,
    );
    cursor = span.end;
  }
  return segments;
}

/**
 * Emits the segments for one range, cut at the matches inside it.
 *
 * `cursorMatch` is threaded through the ranges so a match that starts in one span
 * and ends in the next keeps its highlight across the boundary.
 */
function emitRange(
  segments: CodeRenderSegment[],
  line: CodeLine,
  start: number,
  end: number,
  kind: CodeTokenKind,
  onLine: FileMatch[],
  onLineIndex: number[],
  cursorMatch: number,
  currentMatch: number,
): number {
  let cursor: number = start;
  let match: number = cursorMatch;
  while (cursor < end) {
    while (match < onLine.length && onLine[match].end <= cursor) {
      match++;
    }
    if (match >= onLine.length || onLine[match].start >= end) {
      segments.push(segment(line.text.substring(cursor, end), kind, false, false));
      break;
    }
    const current: FileMatch = onLine[match];
    if (current.start > cursor) {
      // Plain text before the match starts.
      segments.push(segment(line.text.substring(cursor, current.start), kind, false, false));
      cursor = current.start;
      continue;
    }
    const matchEnd: number = Math.min(current.end, end);
    segments.push(segment(
      line.text.substring(cursor, matchEnd), kind, true, onLineIndex[match] === currentMatch,
    ));
    cursor = matchEnd;
    if (current.end <= end) {
      match++;
    }
  }
  return match;
}

function segment(
  text: string,
  kind: CodeTokenKind,
  highlighted: boolean,
  current: boolean,
): CodeRenderSegment {
  return { text: text, kind: kind, highlighted: highlighted, current: current };
}

/**
 * The scroll offset that brings a line into view.
 *
 * Every rendered line is exactly `lineHeight` tall (the renderer disables
 * wrapping, as Android's read-only editor does with `setWordwrap(false)`), so the
 * line's top edge is a multiplication rather than a layout query. The line is
 * parked a third of the way down instead of at the very top, which is what
 * Sora's `ensureSelectionVisible()` amounts to for a single-line jump.
 */
export function scrollOffsetForLine(line: number, lineHeight: number, topPadding: number): number {
  const margin: number = 100;
  const y: number = topPadding + line * lineHeight - margin;
  return y < 0 ? 0 : y;
}
