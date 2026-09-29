/**
 * In-file search - what "find in file" highlights and how it jumps.
 *
 * Four user-visible rules are pinned here: a cleared search box matches nothing
 * (rather than everything), a repeated "find next" walks the text in
 * *non-overlapping* steps (so "aaa" in "aaaaa" is one match, not two), the jump
 * wraps at both ends, and the counter reads one-based with `0/0` when nothing
 * matched. `codeLineSegments` is the renderer's half: token colour and search
 * highlight are independent, so a match may start inside a keyword and end in a
 * comment, and the whitespace the scanner skipped must still be drawn - including
 * the part of it a match covers.
 *
 * Every value below comes from the real `feature/files/FileSearch.ets` through
 * the harness mirror; nothing is re-implemented here.
 */
import { loadModule, suite, expect, finish } from './lib.mjs';

const fileSearch = await loadModule('feature/files/FileSearch.ets');
const { CodeTokenKind } = await loadModule('feature/sessiondetail/CodeTokenizer.ets');

suite('feature/files/FileSearch.ets');

/** One readable line per rendered segment: text, token kind, flags. */
function compact(segments) {
  return segments.map((segment) => `${segment.text}|${segment.kind}`
    + `${segment.highlighted ? '|highlight' : ''}${segment.current ? '|current' : ''}`);
}

/** A line as the tokenizer emits it: spans, with the spaces left out. */
const LINE = 'const x = 1';
const SPANS = [
  { start: 0, end: 5, kind: CodeTokenKind.Keyword },
  { start: 6, end: 7, kind: CodeTokenKind.Plain },
  { start: 8, end: 9, kind: CodeTokenKind.Operator },
  { start: 10, end: 11, kind: CodeTokenKind.Number },
];
function line(text, spans) {
  return { text: text, spans: spans === undefined ? SPANS : spans };
}

// ------------------------------------------------------------------ matching

expect('a cleared search box matches nothing at all',
  [fileSearch.findFileMatches(['alpha', 'beta'], '').length,
    fileSearch.findFileMatches([], 'a').length],
  [0, 0]);
expect('matches are case-insensitive, per line, in reading order',
  fileSearch.findFileMatches(['Alpha', 'beta'], 'a'),
  [{ line: 0, start: 0, end: 1 }, { line: 0, start: 4, end: 5 }, { line: 1, start: 3, end: 4 }]);
expect('every occurrence on a line is found, left to right',
  fileSearch.findFileMatches(['abab'], 'ab'),
  [{ line: 0, start: 0, end: 2 }, { line: 0, start: 2, end: 4 }]);
expect('a repeated find walks non-overlapping occurrences',
  fileSearch.findFileMatches(['aaaaa'], 'aaa'),
  [{ line: 0, start: 0, end: 3 }]);
expect('a query longer than the line is skipped, and blank lines are harmless',
  [fileSearch.findFileMatches(['ab'], 'abc').length,
    fileSearch.findFileMatches(['', 'x'], 'x')],
  [0, [{ line: 1, start: 0, end: 1 }]]);

// -------------------------------------------------------------------- jumping

expect('jumping in an empty result reports no position',
  [fileSearch.cycleFileMatch(0, 0, true), fileSearch.cycleFileMatch(0, -1, true),
    fileSearch.cycleFileMatch(5, 0, false)],
  [-1, -1, -1]);
expect('the jump wraps at both ends',
  [fileSearch.cycleFileMatch(2, 3, true), fileSearch.cycleFileMatch(0, 3, false),
    fileSearch.cycleFileMatch(0, 3, true), fileSearch.cycleFileMatch(1, 3, false)],
  [0, 2, 1, 0]);
expect('a stale position jumps to the first match forwards and the last one backwards',
  [fileSearch.cycleFileMatch(-1, 3, true), fileSearch.cycleFileMatch(-1, 3, false),
    fileSearch.cycleFileMatch(9, 3, true), fileSearch.cycleFileMatch(9, 3, false)],
  [0, 2, 0, 2]);
expect('the counter is one-based and reads 0/0 when nothing matched',
  [fileSearch.fileMatchLabel(0, 3), fileSearch.fileMatchLabel(2, 3),
    fileSearch.fileMatchLabel(0, 0), fileSearch.fileMatchLabel(-1, 3)],
  ['1/3', '3/3', '0/0', '0/0']);

// ----------------------------------------------------------------- rendering

expect('a line without matches is its spaces plus its tokens',
  compact(fileSearch.codeLineSegments(0, line(LINE), [], 0)),
  ['const|2', ' |0', 'x|0', ' |0', '=|10', ' |0', '1|6']);
expect('a match inside a token splits just that token',
  compact(fileSearch.codeLineSegments(0, line(LINE),
    [{ line: 0, start: 0, end: 3 }], 0)).slice(0, 3),
  ['con|2|highlight|current', 'st|2', ' |0']);
expect('a match that spans two tokens keeps its highlight across the boundary',
  compact(fileSearch.codeLineSegments(0, line(LINE),
    [{ line: 0, start: 3, end: 7 }], 0)).slice(0, 4),
  ['con|2', 'st|2|highlight|current', ' |0|highlight|current', 'x|0|highlight|current']);
expect('only the match the search is on is marked current',
  (() => {
    const segments = fileSearch.codeLineSegments(0, line(LINE),
      [{ line: 0, start: 0, end: 3 }, { line: 0, start: 10, end: 11 }], 1);
    return [compact(segments).filter((entry) => entry.includes('highlight')),
      compact(segments).filter((entry) => entry.includes('current'))];
  })(),
  [['con|2|highlight', '1|6|highlight|current'], ['1|6|highlight|current']]);
expect('an empty line renders nothing, and a line with no spans renders itself',
  [fileSearch.codeLineSegments(0, line('', []), [], 0),
    compact(fileSearch.codeLineSegments(0, { text: 'hello', spans: [] }, [], 0))],
  [[], ['hello|0']]);
expect('a match on another line does not touch this one',
  compact(fileSearch.codeLineSegments(0, line(LINE),
    [{ line: 1, start: 0, end: 3 }], 0)),
  ['const|2', ' |0', 'x|0', ' |0', '=|10', ' |0', '1|6']);

// ------------------------------------------------------------------ scrolling

expect('the scroll offset parks the line below the top margin',
  [fileSearch.scrollOffsetForLine(0, 20, 100), fileSearch.scrollOffsetForLine(1, 20, 100),
    fileSearch.scrollOffsetForLine(10, 24, 56)],
  [0, 20, 196]);
expect('a line that would scroll above the top clamps to zero',
  [fileSearch.scrollOffsetForLine(0, 20, 0), fileSearch.scrollOffsetForLine(3, 20, 0),
    fileSearch.scrollOffsetForLine(5, 20, 100)],
  [0, 0, 100]);

finish();
