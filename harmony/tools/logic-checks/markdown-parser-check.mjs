/**
 * Markdown blocks and inline runs — the shapes the transcript renderer consumes.
 *
 * The renderer draws exactly what `parseMarkdown` returns: a wrong block kind
 * puts a paragraph where a code fence belongs, a wrong `language` selects the
 * wrong tokenizer, a wrong `depth` flattens a nested list, and a wrong `link`
 * turns a tappable span into dead text. Every assertion below therefore pins a
 * value a reader of the transcript can see, not merely that the parser returned.
 *
 * `lib.mjs` mirrors the real `.ets`; `lib.mjs` closes the one gap
 * that would otherwise stop this module from loading at all (ArkTS writes its
 * type imports without `import type`, which Node's type stripping then rejects).
 */
import { loadModule, suite, expect, finish } from './lib.mjs';

const md = await loadModule('feature/sessiondetail/MarkdownParser.ets');
const kind = md.MarkdownBlockKind;
suite('feature/sessiondetail/MarkdownParser.ets');

const kinds = (source) => md.parseMarkdown(source).map((block) => block.kind);
const texts = (source) => md.parseMarkdown(source).map((block) => md.inlinePlainText(block.inlines));
const runs = (source) => md.parseInline(source, 0);
const plain = (source) => md.inlinePlainText(md.parseInline(source, 0));

// ---------------------------------------------------------------- block kinds

expect('empty and blank-only sources produce no blocks',
  [md.parseMarkdown(''), kinds('\n\n   \n')], [[], []]);
expect('headings record their level, drop closing hashes, and need a space after the hashes',
  [md.parseMarkdown('# a\n### c').map((block) => block.level), texts('## Title  ###'), kinds('#Hi')],
  [[1, 3], ['Title'], [kind.Paragraph]]);
expect('thematic breaks, paragraphs and list items stay distinct kinds',
  [kinds('---\n* * *\n___'), kinds('text\n- item'), texts('one\n  two\n\nthree')],
  [[kind.ThematicBreak, kind.ThematicBreak, kind.ThematicBreak],
    [kind.Paragraph, kind.ListItem], ['one\ntwo', 'three']]);

// -------------------------------------------------------------- code and quote

const fenced = md.parseMarkdown('```bash extra\nls -la\n```\ntail')[0];
expect('a fence becomes a code block whose language is the info string\'s first token',
  [fenced.kind, fenced.code, fenced.language],
  [kind.CodeBlock, 'ls -la', 'bash']);
expect('a fence info string is lowercased, and an unclosed fence eats the rest of the source',
  [fenced.language, md.parseMarkdown('```JS\na\nb').map((b) => [b.kind, b.language, b.code])],
  ['bash', [[kind.CodeBlock, 'js', 'a\nb']]]);
expect('four leading spaces make an indented code block with no language',
  md.parseMarkdown('    a\n    b\n\nafter').map((b) => [b.kind, b.code, b.language]),
  [[kind.CodeBlock, 'a\nb', ''], [kind.Paragraph, '', '']]);
expect('a blockquote consumes consecutive marker lines and strips one leading space',
  md.parseMarkdown('> a\n>  b\n> c\nplain').map((b) => [b.kind, md.inlinePlainText(b.inlines)]),
  [[kind.Blockquote, 'a\n b\nc'], [kind.Paragraph, 'plain']]);

// -------------------------------------------------------------------- lists

expect('list depth counts two spaces per level, and both ordered markers count as ordered',
  [md.parseMarkdown('- a\n  - b\n    - c').map((b) => [b.marker, b.depth]),
    md.parseMarkdown('1. one\n2) two').map((b) => [b.marker, b.ordered])],
  [[['-', 0], ['-', 1], ['-', 2]], [['1.', true], ['2)', true]]]);
expect('task list state is read from the box, case-insensitively, and only when well formed',
  md.parseMarkdown('- [x] a\n- [X] b\n- [ ] c\n- [] d').map((b) => [b.checked, md.inlinePlainText(b.inlines)]),
  [[true, 'a'], [true, 'b'], [false, 'c'], [null, '[] d']]);

// ------------------------------------------------------------------- tables

const table = md.parseMarkdown('a | b\n--- | :---:\n1 | 2\n3 | 4')[0];
expect('a header plus a delimiter row becomes one table with its cells and alignments',
  [table.kind, table.header.map((cell) => md.inlinePlainText(cell)), table.alignments,
    table.rows.map((row) => row.map((cell) => md.inlinePlainText(cell)))],
  [kind.Table, ['a', 'b'], [md.MarkdownAlignment.None, md.MarkdownAlignment.Center],
    [['1', '2'], ['3', '4']]]);
expect('an escaped pipe stays inside its cell',
  md.parseMarkdown('a\\|z | b\n--- | ---\n1 | 2')[0].header.map((c) => md.inlinePlainText(c)),
  ['a|z', 'b']);
expect('delimiter rows are told apart from ordinary and empty lines',
  ['--- | ---', '---', '| :--- | ---: |', 'not a row', ''].map((line) => md.isDelimiterRow(line)),
  [true, true, true, false, false]);
expect('a table-shaped line inside a fence stays code',
  md.parseMarkdown('```\na | b\n--- | ---\n```').map((b) => b.kind), [kind.CodeBlock]);

// ------------------------------------------------------------------- inline

expect('emphasis, strikethrough and code spans are marked on their runs',
  runs('plain **bold** and *it* and ~~gone~~ and `code` end')
    .map((run) => [run.text, run.bold, run.italic, run.strike, run.code]),
  [
    ['plain ', false, false, false, false],
    ['bold', true, false, false, false],
    [' and ', false, false, false, false],
    ['it', false, true, false, false],
    [' and ', false, false, false, false],
    ['gone', false, false, true, false],
    [' and ', false, false, false, false],
    ['code', false, false, false, true],
    [' end', false, false, false, false],
  ]);
expect('emphasis nests one level into a code span',
  runs('**bold with `code`**').map((run) => [run.text, run.bold, run.code]),
  [['bold with ', true, false], ['code', true, true]]);
expect('a link label carries the target',
  runs('see [label](https://x.test/y) now').filter((run) => run.link !== null)
    .map((run) => [run.text, run.link]),
  [['label', 'https://x.test/y']]);
expect('an autolink and a bare URL both become links',
  runs('a <https://a.test/b> then https://c.test/d.').filter((run) => run.link !== null)
    .map((run) => [run.text, run.link]),
  [['https://a.test/b', 'https://a.test/b'], ['https://c.test/d.', 'https://c.test/d.']]);
expect('anything that does not parse as inline markup stays literal text',
  [plain('a <b> c'), plain('a `b'), plain('a * b * c'), plain('a ** b'), plain('<div>hi</div>')],
  ['a <b> c', 'a `b', 'a * b * c', 'a ** b', '<div>hi</div>']);
expect('a code span holding a file reference is flagged for link styling',
  runs('`src/app/main.ts:42`').map((run) => [run.fileRef, run.code]), [[true, true]]);
expect('file references need a path and an extension, and reject spaces and URLs',
  ['src/app/main.ts:42', 'src/app/main.ts', 'main.ts', 'a b.ts', 'https://a.test/b.ts', '']
    .map((text) => md.looksLikeFileReference(text)),
  [true, true, false, false, false, false]);

// ------------------------------------------------------------- normalisation

expect('a table is separated from the paragraph above it, and left alone at the very top',
  [md.normalizeTables('intro\nh | i\n--- | ---\nb | c'), md.normalizeTables('h | i\n--- | ---\nb | c')],
  ['intro\n\nh | i\n--- | ---\nb | c', 'h | i\n--- | ---\nb | c']);
expect('a table-looking line inside a fence is not normalised, and plain text is untouched',
  [md.normalizeTables('```\nh | i\n--- | ---\n```'), md.normalizeTables('a\nb')],
  ['```\nh | i\n--- | ---\n```', 'a\nb']);

finish();
