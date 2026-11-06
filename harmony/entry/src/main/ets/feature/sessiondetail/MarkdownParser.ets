/**
 * A small CommonMark subset parser.
 *
 * The Android client uses `org.commonmark` with the autolink, strikethrough,
 * table and task-list extensions. The port keeps the same supported syntax but
 * parses it in-tree, because the HarmonyOS build is deliberately dependency-free.
 *
 * Supported blocks: ATX headings (`#` to `######`), fenced and indented code,
 * blockquotes, bullet and ordered lists (including task list items), thematic
 * breaks, and pipe tables. Paragraphs are the fallback.
 *
 * Supported inline: bold, italic, strikethrough, code spans, `[text](url)` links,
 * `<url>` autolinks and bare URLs. Emphasis nests one level deep, which covers
 * what models actually emit without a full delimiter-stack implementation.
 *
 * Raw HTML is not parsed: it is emitted as literal text, matching Android.
 */

/** What a block is. */
export enum MarkdownBlockKind {
  Paragraph = 0,
  Heading = 1,
  CodeBlock = 2,
  Blockquote = 3,
  ListItem = 4,
  ThematicBreak = 5,
  Table = 6,
}

/** Column alignment for a table cell. */
export enum MarkdownAlignment {
  None = 0,
  Left = 1,
  Center = 2,
  Right = 3,
}

/** A run of text with one combination of inline styling. */
export interface MarkdownInline {
  text: string;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  /** Set when the run is a link target; rendered as a tappable span. */
  link: string | null;
  /** True when the run looks like a file reference, which Android styles as a link. */
  fileRef: boolean;
}

export interface MarkdownBlock {
  kind: MarkdownBlockKind;
  /** Heading level, 1-6. */
  level: number;
  inlines: MarkdownInline[];
  /** Fenced or indented code body, without the fence. */
  code: string;
  /** Fence info string before the first space, e.g. `bash`. */
  language: string;
  /** List item marker, e.g. `-` or `1.`. */
  marker: string;
  ordered: boolean;
  /** Task list state: null when the item is not a task. */
  checked: boolean | null;
  /** List nesting depth, 0 for a top-level item. */
  depth: number;
  /** Table header cells. */
  header: MarkdownInline[][];
  alignments: MarkdownAlignment[];
  /** Table body rows, each a list of cells. */
  rows: MarkdownInline[][][];
}

const FENCE_PATTERN = /^(\s{0,3})(`{3,}|~{3,})\s*(.*)$/;
const HEADING_PATTERN = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const THEMATIC_PATTERN = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_PATTERN = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const DELIMITER_PATTERN = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Parses a Markdown document into blocks. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const normalized: string = normalizeTables(source);
  const lines: string[] = normalized.split('\n');
  const blocks: MarkdownBlock[] = [];
  let index: number = 0;

  while (index < lines.length) {
    const line: string = lines[index];

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    // Fenced code.
    const fence: RegExpMatchArray | null = line.match(FENCE_PATTERN);
    if (fence !== null) {
      const marker: string = fence[2];
      const info: string = fence[3].trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith(marker.substring(0, 3))) {
        body.push(lines[index]);
        index += 1;
      }
      // Skip the closing fence when one exists.
      if (index < lines.length) {
        index += 1;
      }
      blocks.push(codeBlock(body.join('\n'), info));
      continue;
    }

    const heading: RegExpMatchArray | null = line.match(HEADING_PATTERN);
    if (heading !== null) {
      blocks.push({
        kind: MarkdownBlockKind.Heading,
        level: heading[1].length,
        inlines: parseInline(heading[2], 0),
        code: '',
        language: '',
        marker: '',
        ordered: false,
        checked: null,
        depth: 0,
        header: [],
        alignments: [],
        rows: [],
      });
      index += 1;
      continue;
    }

    if (THEMATIC_PATTERN.test(line)) {
      blocks.push(emptyBlock(MarkdownBlockKind.ThematicBreak));
      index += 1;
      continue;
    }

    // Table: the current line plus a delimiter row.
    if (line.includes('|') && index + 1 < lines.length && isDelimiterRow(lines[index + 1])) {
      const alignments: MarkdownAlignment[] = parseAlignments(lines[index + 1]);
      const header: MarkdownInline[][] = parseTableRow(line);
      const rows: MarkdownInline[][][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|')
        && lines[index].trim().length > 0) {
        rows.push(parseTableRow(lines[index]));
        index += 1;
      }
      const block: MarkdownBlock = emptyBlock(MarkdownBlockKind.Table);
      block.header = header;
      block.alignments = alignments;
      block.rows = rows;
      blocks.push(block);
      continue;
    }

    // Blockquote: consecutive `>` lines.
    if (line.trimStart().startsWith('>')) {
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index].trimStart().startsWith('>')) {
        const stripped: string = lines[index].trimStart().substring(1);
        quoteLines.push(stripped.startsWith(' ') ? stripped.substring(1) : stripped);
        index += 1;
      }
      const block: MarkdownBlock = emptyBlock(MarkdownBlockKind.Blockquote);
      block.inlines = parseInline(quoteLines.join('\n'), 0);
      blocks.push(block);
      continue;
    }

    // List item.
    const listMatch: RegExpMatchArray | null = line.match(LIST_PATTERN);
    if (listMatch !== null) {
      blocks.push(parseListItem(listMatch));
      index += 1;
      continue;
    }

    // Indented code: four leading spaces after a blank line.
    if (line.startsWith('    ')) {
      const body: string[] = [];
      while (index < lines.length
        && (lines[index].startsWith('    ') || lines[index].trim().length === 0)) {
        body.push(lines[index].startsWith('    ') ? lines[index].substring(4) : '');
        index += 1;
      }
      while (body.length > 0 && body[body.length - 1].trim().length === 0) {
        body.pop();
      }
      blocks.push(codeBlock(body.join('\n'), ''));
      continue;
    }

    // Paragraph: gather until a blank line or the start of another block.
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim().length > 0
      && !startsNewBlock(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    if (paragraph.length > 0) {
      const block: MarkdownBlock = emptyBlock(MarkdownBlockKind.Paragraph);
      block.inlines = parseInline(paragraph.join('\n'), 0);
      blocks.push(block);
    } else {
      // Defensive: never loop forever on a line nothing claimed.
      index += 1;
    }
  }

  return blocks;
}

function startsNewBlock(lines: string[], index: number): boolean {
  const line: string = lines[index];
  if (FENCE_PATTERN.test(line) || HEADING_PATTERN.test(line) || THEMATIC_PATTERN.test(line)) {
    return true;
  }
  if (line.trimStart().startsWith('>') || LIST_PATTERN.test(line)) {
    return true;
  }
  if (line.includes('|') && index + 1 < lines.length && isDelimiterRow(lines[index + 1])) {
    return true;
  }
  return false;
}

function emptyBlock(kind: MarkdownBlockKind): MarkdownBlock {
  return {
    kind: kind,
    level: 0,
    inlines: [],
    code: '',
    language: '',
    marker: '',
    ordered: false,
    checked: null,
    depth: 0,
    header: [],
    alignments: [],
    rows: [],
  };
}

function codeBlock(code: string, info: string): MarkdownBlock {
  const block: MarkdownBlock = emptyBlock(MarkdownBlockKind.CodeBlock);
  block.code = code;
  // The language is the first token of the info string, as Android reads it.
  const space: number = info.indexOf(' ');
  const language: string = space > 0 ? info.substring(0, space) : info;
  // Android lowercases the label for the syntax mapping.
  block.language = language.toLowerCase();
  return block;
}

function parseListItem(match: RegExpMatchArray): MarkdownBlock {
  const indent: string = match[1];
  const marker: string = match[2];
  let content: string = match[3];
  const block: MarkdownBlock = emptyBlock(MarkdownBlockKind.ListItem);
  block.marker = marker;
  block.ordered = /^\d/.test(marker);
  // Two spaces per nesting level, matching how the sources indent lists.
  block.depth = Math.floor(indent.replace(/\t/g, '  ').length / 2);

  const taskMatch: RegExpMatchArray | null = content.match(/^\[([ xX])\]\s+(.*)$/);
  if (taskMatch !== null) {
    block.checked = taskMatch[1].toLowerCase() === 'x';
    content = taskMatch[2];
  }
  block.inlines = parseInline(content, 0);
  return block;
}

/** True when the line is a table delimiter row. */
export function isDelimiterRow(line: string): boolean {
  const trimmed: string = line.trim();
  if (trimmed.length === 0 || !trimmed.includes('-')) {
    return false;
  }
  return DELIMITER_PATTERN.test(line);
}

function parseAlignments(line: string): MarkdownAlignment[] {
  const cells: string[] = splitTableRow(line);
  const alignments: MarkdownAlignment[] = [];
  for (const cell of cells) {
    const trimmed: string = cell.trim();
    const left: boolean = trimmed.startsWith(':');
    const right: boolean = trimmed.endsWith(':');
    if (left && right) {
      alignments.push(MarkdownAlignment.Center);
    } else if (right) {
      alignments.push(MarkdownAlignment.Right);
    } else if (left) {
      alignments.push(MarkdownAlignment.Left);
    } else {
      alignments.push(MarkdownAlignment.None);
    }
  }
  return alignments;
}

function parseTableRow(line: string): MarkdownInline[][] {
  const cells: string[] = splitTableRow(line);
  const parsed: MarkdownInline[][] = [];
  for (const cell of cells) {
    parsed.push(parseInline(cell.trim(), 0));
  }
  return parsed;
}

/** Splits a table row on unescaped pipes, dropping the optional outer pipes. */
function splitTableRow(line: string): string[] {
  let trimmed: string = line.trim();
  if (trimmed.startsWith('|')) {
    trimmed = trimmed.substring(1);
  }
  if (trimmed.endsWith('|')) {
    trimmed = trimmed.substring(0, trimmed.length - 1);
  }
  const cells: string[] = [];
  let current: string = '';
  let index: number = 0;
  while (index < trimmed.length) {
    const char: string = trimmed.charAt(index);
    if (char === '\\' && index + 1 < trimmed.length) {
      current += trimmed.charAt(index + 1);
      index += 2;
      continue;
    }
    if (char === '|') {
      cells.push(current);
      current = '';
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  cells.push(current);
  return cells;
}

/**
 * Inserts a blank line before a table header whose next line is a delimiter row.
 *
 * CommonMark requires the blank line; models rarely emit it, so the same
 * normalisation Android applies runs first.
 */
export function normalizeTables(source: string): string {
  const lines: string[] = source.split('\n');
  const out: string[] = [];
  let insideFence: boolean = false;
  for (let index = 0; index < lines.length; index++) {
    const line: string = lines[index];
    if (FENCE_PATTERN.test(line)) {
      insideFence = !insideFence;
      out.push(line);
      continue;
    }
    if (!insideFence && line.includes('|') && index + 1 < lines.length
      && isDelimiterRow(lines[index + 1])) {
      const previous: string | undefined = out.length > 0 ? out[out.length - 1] : undefined;
      if (previous !== undefined && previous.trim().length > 0) {
        out.push('');
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

// -------------------------------------------------------------------- inline

const FILE_REF_PATTERN = /^[^\s]+\.(?:[A-Za-z0-9]{1,8})(?::\d+(?::\d+)?)?$/;
const FILE_EXTENSION_PATTERN = /\.[a-zA-Z0-9]+(?::\d+(?::\d+)?)?$/;

function inlineRun(text: string, overrides: InlineStyle): MarkdownInline {
  return {
    text: text,
    bold: overrides.bold,
    italic: overrides.italic,
    strike: overrides.strike,
    code: overrides.code,
    link: overrides.link,
    fileRef: overrides.fileRef,
  };
}

interface InlineStyle {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  link: string | null;
  fileRef: boolean;
}

function baseStyle(): InlineStyle {
  return { bold: false, italic: false, strike: false, code: false, link: null, fileRef: false };
}

/** True when the text looks like a file reference such as `src/app/main.ts:42`. */
export function looksLikeFileReference(text: string): boolean {
  if (text.length === 0 || text.includes(' ') || text.includes('://') || !text.includes('/')) {
    return false;
  }
  return FILE_EXTENSION_PATTERN.test(text) && FILE_REF_PATTERN.test(text);
}

/**
 * Splits text into styled runs.
 *
 * `depth` bounds emphasis nesting so pathological input cannot recurse forever.
 */
export function parseInline(text: string, depth: number): MarkdownInline[] {
  const runs: MarkdownInline[] = [];
  const style: InlineStyle = baseStyle();
  let buffer: string = '';
  let index: number = 0;

  const flush = (): void => {
    if (buffer.length > 0) {
      runs.push(inlineRun(buffer, style));
      buffer = '';
    }
  };

  while (index < text.length) {
    const char: string = text.charAt(index);
    const rest: string = text.substring(index);

    // Code span: content is literal, so it is closed before anything else.
    if (char === '`') {
      const closing: number = rest.indexOf('`', 1);
      if (closing > 0) {
        flush();
        const codeText: string = rest.substring(1, closing);
        const codeStyle: InlineStyle = baseStyle();
        codeStyle.code = true;
        codeStyle.fileRef = looksLikeFileReference(codeText);
        runs.push(inlineRun(codeText, codeStyle));
        index += closing + 1;
        continue;
      }
    }

    // Link: [text](url)
    if (char === '[') {
      const closeBracket: number = rest.indexOf('](');
      if (closeBracket > 0) {
        const closeParen: number = rest.indexOf(')', closeBracket + 2);
        if (closeParen > 0) {
          flush();
          const label: string = rest.substring(1, closeBracket);
          const target: string = rest.substring(closeBracket + 2, closeParen).trim();
          const linkStyle: InlineStyle = baseStyle();
          linkStyle.link = target;
          const childRuns: MarkdownInline[] = depth < 2 ? parseInline(label, depth + 1) : [];
          if (childRuns.length === 0) {
            runs.push(inlineRun(label, linkStyle));
          } else {
            for (const child of childRuns) {
              child.link = target;
              runs.push(child);
            }
          }
          index += closeParen + 1;
          continue;
        }
      }
    }

    // Autolink: <https://…>
    if (char === '<') {
      const closeAngle: number = rest.indexOf('>', 1);
      if (closeAngle > 0) {
        const target: string = rest.substring(1, closeAngle);
        if (target.startsWith('http://') || target.startsWith('https://')) {
          flush();
          const linkStyle: InlineStyle = baseStyle();
          linkStyle.link = target;
          runs.push(inlineRun(target, linkStyle));
          index += closeAngle + 1;
          continue;
        }
      }
    }

    // Emphasis. Longest markers are tried first so `**` beats `*`.
    if (depth < 2 && (rest.startsWith('**') || rest.startsWith('__'))) {
      const marker: string = rest.substring(0, 2);
      const closing: number = rest.indexOf(marker, 2);
      if (closing > 2) {
        flush();
        const inner: string = rest.substring(2, closing);
        const childRuns: MarkdownInline[] = parseInline(inner, depth + 1);
        for (const child of childRuns) {
          child.bold = true;
          runs.push(child);
        }
        index += closing + 2;
        continue;
      }
    }
    if (depth < 2 && rest.startsWith('~~')) {
      const closing: number = rest.indexOf('~~', 2);
      if (closing > 2) {
        flush();
        const inner: string = rest.substring(2, closing);
        const childRuns: MarkdownInline[] = parseInline(inner, depth + 1);
        for (const child of childRuns) {
          child.strike = true;
          runs.push(child);
        }
        index += closing + 2;
        continue;
      }
    }
    if (depth < 2 && (char === '*' || char === '_')) {
      const closing: number = rest.indexOf(char, 1);
      // Reject an empty span and one that would swallow a space.
      if (closing > 1 && rest.charAt(1) !== ' ') {
        flush();
        const inner: string = rest.substring(1, closing);
        const childRuns: MarkdownInline[] = parseInline(inner, depth + 1);
        for (const child of childRuns) {
          child.italic = true;
          runs.push(child);
        }
        index += closing + 1;
        continue;
      }
    }

    // Bare URL: start a link run that ends at whitespace.
    if (rest.startsWith('http://') || rest.startsWith('https://')) {
      flush();
      let end: number = index;
      while (end < text.length && !/\s/.test(text.charAt(end))) {
        end += 1;
      }
      const target: string = text.substring(index, end);
      const linkStyle: InlineStyle = baseStyle();
      linkStyle.link = target;
      runs.push(inlineRun(target, linkStyle));
      index = end;
      continue;
    }

    buffer += char;
    index += 1;
  }

  flush();
  return runs;
}

/** Plain text of a run list, used for accessibility and copy actions. */
export function inlinePlainText(runs: MarkdownInline[]): string {
  let out: string = '';
  for (const run of runs) {
    out += run.text;
  }
  return out;
}
