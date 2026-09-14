import { CodeLanguageSpec, CodeLexerStyle } from './CodeLanguage';

/**
 * Lightweight code scanner.
 *
 * Android hands the code to Sora Editor with a TextMate grammar; there is no
 * equivalent engine here, so tokens are classified by a hand-written scanner.
 * The taxonomy and the colours are deliberately the ones the TextMate themes
 * (`quietlight` and `darcula`) assign to the same scopes, which is what makes the
 * output comparable even though the grammars are not.
 *
 * The classification is a heuristic, and is documented as such:
 *
 *  - a word in the language's keyword table is a keyword;
 *  - a word after `def`/`function`/`func`/`fn` is a function, and after
 *    `class`/`struct`/`interface`/`enum`/… is a type;
 *  - an identifier immediately followed by `(` is a function;
 *  - an identifier starting uppercase is a type;
 *  - everything else stays plain, rather than colouring every identifier the way
 *    a grammar's `variable` scope would.
 *
 * Scanning is per line with a carried state for block comments, triple-quoted
 * strings, markup tags and CSS blocks. Both the line count and the total span
 * count are capped so a pathological block cannot stall rendering; the remainder
 * is emitted as plain text.
 */

export enum CodeTokenKind {
  Plain = 0,
  Comment = 1,
  Keyword = 2,
  Type = 3,
  Selector = 4,
  Function = 5,
  Number = 6,
  String = 7,
  Constant = 8,
  Variable = 9,
  Operator = 10,
  Punctuation = 11,
  Tag = 12,
  Attribute = 13,
  PropertyKey = 14,
}

export interface CodeSpan {
  start: number;
  end: number;
  kind: CodeTokenKind;
}

export interface CodeLine {
  spans: CodeSpan[];
  /**
   * The line's own text, without the line break.
   *
   * The scanner does not emit spans for the whitespace between tokens, so a
   * renderer that walks the spans alone would drop every space; carrying the text
   * lets it fill those gaps without having to re-split the source.
   */
  text: string;
}

export interface CodeTokenization {
  lines: CodeLine[];
  /** True when the caps dropped part of the input; the tail renders plain. */
  truncated: boolean;
}

/** Matches the panel's fixed-height arithmetic: 2000 lines is already 30k px. */
const MAX_LINES: number = 2000;
const MAX_SPANS: number = 40000;

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isIdentStart(code: number): boolean {
  return isLetter(code) || code === 95 || code === 36;
}

function isIdentPart(code: number): boolean {
  return isLetter(code) || isDigit(code) || code === 95 || code === 36;
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9;
}

const OPERATORS: string = '+-*/%=<>!&|^~?:';
const PUNCTUATION: string = '(){}[];,.';

/** A scanner instance per tokenization, because it carries multi-line state. */
class CodeScanner {
  private readonly language: CodeLanguageSpec | null;
  private readonly style: CodeLexerStyle;
  private inBlockComment: boolean = false;
  private tripleDelimiter: string = '';
  private inMarkupComment: boolean = false;
  private inTag: boolean = false;
  /** CSS: inside a declaration block, and after the property's colon. */
  private inCssBlock: boolean = false;
  private afterCssColon: boolean = false;
  /** The last keyword emitted on this line, used for declaration heuristics. */
  private lastKeyword: string = '';

  constructor(language: CodeLanguageSpec | null) {
    this.language = language;
    this.style = language === null ? CodeLexerStyle.Plain : language.style;
  }

  scan(line: string): CodeSpan[] {
    const spans: CodeSpan[] = [];
    if (this.language === null || this.style === CodeLexerStyle.Plain) {
      if (line.length > 0) {
        spans.push({ start: 0, end: line.length, kind: CodeTokenKind.Plain });
      }
      return spans;
    }
    this.lastKeyword = '';
    if (this.style === CodeLexerStyle.Markup) {
      this.scanMarkup(line, spans);
    } else if (this.style === CodeLexerStyle.Css) {
      this.scanCss(line, spans);
    } else {
      this.scanGeneric(line, spans);
    }
    return coalesce(spans);
  }

  // ------------------------------------------------------------- generic

  private scanGeneric(line: string, spans: CodeSpan[]): void {
    const language: CodeLanguageSpec = this.language as CodeLanguageSpec;
    const length: number = line.length;
    let index: number = 0;

    // A data file's key sits at the start of the line, before any separator.
    if (language.detectKeys && !this.inBlockComment) {
      const keyEnd: number = dataKeyEnd(line, language);
      if (keyEnd > 0) {
        spans.push({ start: 0, end: keyEnd, kind: CodeTokenKind.PropertyKey });
        index = keyEnd;
      }
    }

    while (index < length) {
      const code: number = line.charCodeAt(index);

      if (this.inBlockComment) {
        const end: number = line.indexOf('*/', index);
        if (end < 0) {
          spans.push({ start: index, end: length, kind: CodeTokenKind.Comment });
          return;
        }
        spans.push({ start: index, end: end + 2, kind: CodeTokenKind.Comment });
        this.inBlockComment = false;
        index = end + 2;
        continue;
      }

      if (this.tripleDelimiter.length > 0) {
        const end: number = line.indexOf(this.tripleDelimiter, index);
        if (end < 0) {
          spans.push({ start: index, end: length, kind: CodeTokenKind.String });
          return;
        }
        spans.push({ start: index, end: end + 3, kind: CodeTokenKind.String });
        this.tripleDelimiter = '';
        index = end + 3;
        continue;
      }

      if (isSpace(code)) {
        index++;
        continue;
      }

      const lineComment: number = this.lineCommentAt(line, index);
      if (lineComment > 0) {
        spans.push({ start: index, end: length, kind: CodeTokenKind.Comment });
        return;
      }

      if (language.blockComments && line.startsWith('/*', index)) {
        this.inBlockComment = true;
        continue;
      }

      const quote: string = line.charAt(index);
      if (language.quotes.includes(quote)) {
        if (language.tripleQuotes && line.startsWith(quote + quote + quote, index)) {
          const delimiter: string = quote + quote + quote;
          const end: number = line.indexOf(delimiter, index + 3);
          if (end < 0) {
            this.tripleDelimiter = delimiter;
            spans.push({ start: index, end: length, kind: CodeTokenKind.String });
            return;
          }
          spans.push({ start: index, end: end + 3, kind: CodeTokenKind.String });
          index = end + 3;
          continue;
        }
        const end: number = stringEnd(line, index, quote);
        spans.push({ start: index, end: end, kind: CodeTokenKind.String });
        index = end;
        continue;
      }

      if (language.variablePrefixes.includes(quote) && index + 1 < length
        && (isIdentStart(line.charCodeAt(index + 1)) || line.charAt(index + 1) === '{')) {
        let end: number = index + 1;
        if (line.charAt(end) === '{') {
          const close: number = line.indexOf('}', end);
          end = close < 0 ? length : close + 1;
        } else {
          while (end < length && isIdentPart(line.charCodeAt(end))) {
            end++;
          }
        }
        spans.push({ start: index, end: end, kind: CodeTokenKind.Variable });
        index = end;
        continue;
      }

      if (isDigit(code) || (quote === '.' && index + 1 < length && isDigit(line.charCodeAt(index + 1)))) {
        const end: number = numberEnd(line, index);
        spans.push({ start: index, end: end, kind: CodeTokenKind.Number });
        index = end;
        continue;
      }

      // A C-like preprocessor directive is a keyword, as TextMate treats it.
      if (quote === '#' && index === 0 && this.style === CodeLexerStyle.CLike) {
        let end: number = index + 1;
        while (end < length && isIdentPart(line.charCodeAt(end))) {
          end++;
        }
        spans.push({ start: index, end: end, kind: CodeTokenKind.Keyword });
        index = end;
        continue;
      }

      if (isIdentStart(code)) {
        let end: number = index;
        while (end < length && isIdentPart(line.charCodeAt(end))) {
          end++;
        }
        const word: string = line.substring(index, end);
        const kind: CodeTokenKind = this.classify(word, line, end);
        spans.push({
          start: index,
          end: end,
          kind: kind,
        });
        // A declaration keyword names only the word that follows it, so it is
        // cleared as soon as any other token has been classified.
        this.lastKeyword = kind === CodeTokenKind.Keyword ? word.toLowerCase() : '';
        index = end;
        continue;
      }

      if (OPERATORS.includes(quote)) {
        let end: number = index;
        while (end < length && OPERATORS.includes(line.charAt(end))) {
          end++;
        }
        spans.push({ start: index, end: end, kind: CodeTokenKind.Operator });
        index = end;
        continue;
      }

      if (PUNCTUATION.includes(quote)) {
        spans.push({ start: index, end: index + 1, kind: CodeTokenKind.Punctuation });
        index++;
        continue;
      }

      spans.push({ start: index, end: index + 1, kind: CodeTokenKind.Plain });
      index++;
    }
  }

  /** A line comment starts here, unless the marker is `#` inside a word. */
  private lineCommentAt(line: string, index: number): number {
    const language: CodeLanguageSpec = this.language as CodeLanguageSpec;
    for (const marker of language.lineComments) {
      if (!line.startsWith(marker, index)) {
        continue;
      }
      if (marker === '#' && index > 0) {
        const before: number = line.charCodeAt(index - 1);
        if (!isSpace(before)) {
          continue;
        }
      }
      return marker.length;
    }
    return 0;
  }

  private classify(word: string, line: string, end: number): CodeTokenKind {
    const language: CodeLanguageSpec = this.language as CodeLanguageSpec;
    const lower: string = word.toLowerCase();
    const keyword: string = language.caseInsensitive ? lower : word;
    if (language.keywords.has(keyword)) {
      return CodeTokenKind.Keyword;
    }
    if (language.constants.has(lower) || language.constants.has(word)) {
      return CodeTokenKind.Constant;
    }
    if (language.functionIntroducers.has(this.lastKeyword)) {
      return CodeTokenKind.Function;
    }
    if (language.typeIntroducers.has(this.lastKeyword)) {
      return CodeTokenKind.Type;
    }
    if (nextNonSpace(line, end) === '(') {
      return CodeTokenKind.Function;
    }
    if (this.style !== CodeLexerStyle.Data && isLetter(word.charCodeAt(0))
      && word.charCodeAt(0) >= 65 && word.charCodeAt(0) <= 90) {
      return CodeTokenKind.Type;
    }
    return CodeTokenKind.Plain;
  }

  // -------------------------------------------------------------- markup

  private scanMarkup(line: string, spans: CodeSpan[]): void {
    const length: number = line.length;
    let index: number = 0;
    while (index < length) {
      if (this.inMarkupComment) {
        const end: number = line.indexOf('-->', index);
        if (end < 0) {
          spans.push({ start: index, end: length, kind: CodeTokenKind.Comment });
          return;
        }
        spans.push({ start: index, end: end + 3, kind: CodeTokenKind.Comment });
        this.inMarkupComment = false;
        index = end + 3;
        continue;
      }

      if (!this.inTag) {
        const open: number = line.indexOf('<', index);
        if (open < 0) {
          this.pushMarkupText(line, index, length, spans);
          return;
        }
        if (open > index) {
          this.pushMarkupText(line, index, open, spans);
        }
        if (line.startsWith('<!--', open)) {
          this.inMarkupComment = true;
          index = open;
          continue;
        }
        if (line.startsWith('<!', open) || line.startsWith('<?', open)) {
          const close: number = line.indexOf('>', open);
          const end: number = close < 0 ? length : close + 1;
          spans.push({ start: open, end: end, kind: CodeTokenKind.Comment });
          index = end;
          continue;
        }
        this.inTag = true;
        let cursor: number = open + 1;
        if (line.charAt(cursor) === '/') {
          cursor++;
        }
        spans.push({ start: open, end: cursor, kind: CodeTokenKind.Punctuation });
        let nameEnd: number = cursor;
        while (nameEnd < length && isIdentPart(line.charCodeAt(nameEnd))) {
          nameEnd++;
        }
        if (nameEnd > cursor) {
          spans.push({ start: cursor, end: nameEnd, kind: CodeTokenKind.Tag });
        }
        index = nameEnd;
        continue;
      }

      const char: string = line.charAt(index);
      if (isSpace(line.charCodeAt(index))) {
        index++;
        continue;
      }
      if (char === '/' && line.charAt(index + 1) === '>') {
        spans.push({ start: index, end: index + 2, kind: CodeTokenKind.Punctuation });
        this.inTag = false;
        index += 2;
        continue;
      }
      if (char === '>' || char === '/') {
        spans.push({ start: index, end: index + 1, kind: CodeTokenKind.Punctuation });
        this.inTag = false;
        index++;
        continue;
      }
      if (char === '=') {
        spans.push({ start: index, end: index + 1, kind: CodeTokenKind.Operator });
        index++;
        continue;
      }
      if (char === '"' || char === '\'') {
        const end: number = stringEnd(line, index, char);
        spans.push({ start: index, end: end, kind: CodeTokenKind.String });
        index = end;
        continue;
      }
      if (isIdentStart(line.charCodeAt(index))) {
        let end: number = index;
        while (end < length && (isIdentPart(line.charCodeAt(end)) || line.charAt(end) === '-')) {
          end++;
        }
        spans.push({ start: index, end: end, kind: CodeTokenKind.Attribute });
        index = end;
        continue;
      }
      spans.push({ start: index, end: index + 1, kind: CodeTokenKind.Plain });
      index++;
    }
  }

  /** Text between tags; entities are the one thing TextMate colours there. */
  private pushMarkupText(line: string, start: number, end: number, spans: CodeSpan[]): void {
    let index: number = start;
    while (index < end) {
      const amp: number = line.indexOf('&', index);
      if (amp < 0 || amp >= end) {
        spans.push({ start: index, end: end, kind: CodeTokenKind.Plain });
        return;
      }
      const semi: number = line.indexOf(';', amp);
      if (semi < 0 || semi >= end) {
        spans.push({ start: index, end: end, kind: CodeTokenKind.Plain });
        return;
      }
      if (amp > index) {
        spans.push({ start: index, end: amp, kind: CodeTokenKind.Plain });
      }
      spans.push({ start: amp, end: semi + 1, kind: CodeTokenKind.Constant });
      index = semi + 1;
    }
  }

  // ----------------------------------------------------------------- css

  private scanCss(line: string, spans: CodeSpan[]): void {
    const length: number = line.length;
    let index: number = 0;
    while (index < length) {
      if (this.inBlockComment) {
        const end: number = line.indexOf('*/', index);
        if (end < 0) {
          spans.push({ start: index, end: length, kind: CodeTokenKind.Comment });
          return;
        }
        spans.push({ start: index, end: end + 2, kind: CodeTokenKind.Comment });
        this.inBlockComment = false;
        index = end + 2;
        continue;
      }
      if (line.startsWith('/*', index)) {
        this.inBlockComment = true;
        continue;
      }

      const char: string = line.charAt(index);
      if (isSpace(line.charCodeAt(index))) {
        index++;
        continue;
      }
      if (char === '"' || char === '\'') {
        const end: number = stringEnd(line, index, char);
        spans.push({ start: index, end: end, kind: CodeTokenKind.String });
        index = end;
        continue;
      }
      if (char === '{') {
        this.inCssBlock = true;
        this.afterCssColon = false;
        spans.push({ start: index, end: index + 1, kind: CodeTokenKind.Punctuation });
        index++;
        continue;
      }
      if (char === '}') {
        this.inCssBlock = false;
        this.afterCssColon = false;
        spans.push({ start: index, end: index + 1, kind: CodeTokenKind.Punctuation });
        index++;
        continue;
      }
      if (char === ':') {
        if (this.inCssBlock) {
          this.afterCssColon = true;
        }
        spans.push({ start: index, end: index + 1, kind: CodeTokenKind.Punctuation });
        index++;
        continue;
      }
      if (char === ';') {
        this.afterCssColon = false;
        spans.push({ start: index, end: index + 1, kind: CodeTokenKind.Punctuation });
        index++;
        continue;
      }
      if (char === '#') {
        let end: number = index + 1;
        while (end < length && isHex(line.charCodeAt(end))) {
          end++;
        }
        if (end > index + 1) {
          spans.push({ start: index, end: end, kind: CodeTokenKind.Number });
          index = end;
          continue;
        }
        spans.push({ start: index, end: index + 1, kind: CodeTokenKind.Punctuation });
        index++;
        continue;
      }
      if (isDigit(line.charCodeAt(index))) {
        const end: number = numberEnd(line, index);
        spans.push({ start: index, end: end, kind: CodeTokenKind.Number });
        index = end;
        continue;
      }
      if (isIdentStart(line.charCodeAt(index)) || char === '.' || char === '@' || char === '%') {
        let start: number = index;
        if (char === '.' || char === '@' || char === '%') {
          start = index + 1;
        }
        let end: number = start;
        while (end < length && (isIdentPart(line.charCodeAt(end)) || line.charAt(end) === '-')) {
          end++;
        }
        if (end === start) {
          spans.push({ start: index, end: start, kind: CodeTokenKind.Punctuation });
          index = start;
          continue;
        }
        let kind: CodeTokenKind = CodeTokenKind.Selector;
        if (this.inCssBlock) {
          kind = this.afterCssColon ? CodeTokenKind.Plain : CodeTokenKind.PropertyKey;
          if (this.afterCssColon && this.language !== null
            && this.language.keywords.has(line.substring(start, end).toLowerCase())) {
            kind = CodeTokenKind.Keyword;
          }
        } else if (char === '@' && this.language !== null
          && this.language.keywords.has(line.substring(start, end).toLowerCase())) {
          kind = CodeTokenKind.Keyword;
        }
        if (index < start) {
          spans.push({ start: index, end: start, kind: CodeTokenKind.Punctuation });
        }
        spans.push({ start: start, end: end, kind: kind });
        index = end;
        continue;
      }
      spans.push({ start: index, end: index + 1, kind: CodeTokenKind.Plain });
      index++;
    }
  }
}

function isHex(code: number): boolean {
  return isDigit(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function nextNonSpace(line: string, from: number): string {
  let index: number = from;
  while (index < line.length && isSpace(line.charCodeAt(index))) {
    index++;
  }
  return index < line.length ? line.charAt(index) : '';
}

/** The end of a quoted string, honouring backslash escapes. */
function stringEnd(line: string, start: number, quote: string): number {
  let index: number = start + 1;
  while (index < line.length) {
    const char: string = line.charAt(index);
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) {
      return index + 1;
    }
    index++;
  }
  return line.length;
}

/** The end of a numeric literal, including hex, exponents and separators. */
function numberEnd(line: string, start: number): number {
  let index: number = start;
  let previous: string = '';
  while (index < line.length) {
    const char: string = line.charAt(index);
    const code: number = line.charCodeAt(index);
    if (isDigit(code) || isHex(code) || char === '.' || char === '_' || char === 'x'
      || char === 'X' || char === 'o' || char === 'O' || char === 'b' || char === 'B') {
      previous = char;
      index++;
      continue;
    }
    if ((char === '+' || char === '-') && (previous === 'e' || previous === 'E')) {
      previous = char;
      index++;
      continue;
    }
    break;
  }
  return index;
}

/** A data key: optional indent, optional list dash, then a key before a separator. */
function dataKeyEnd(line: string, language: CodeLanguageSpec): number {
  let index: number = 0;
  while (index < line.length && isSpace(line.charCodeAt(index))) {
    index++;
  }
  if (line.charAt(index) === '-' && isSpace(line.charCodeAt(index + 1))) {
    index += 2;
    while (index < line.length && isSpace(line.charCodeAt(index))) {
      index++;
    }
  }
  const start: number = index;
  const quote: string = line.charAt(index);
  if (quote === '"' || quote === '\'') {
    const end: number = stringEnd(line, index, quote);
    if (end <= start + 1) {
      return -1;
    }
    return separatorAfter(line, end, language) ? end : -1;
  }
  while (index < line.length && (isIdentPart(line.charCodeAt(index)) || line.charAt(index) === '-'
    || line.charAt(index) === '.')) {
    index++;
  }
  if (index === start) {
    return -1;
  }
  return separatorAfter(line, index, language) ? index : -1;
}

function separatorAfter(line: string, from: number, language: CodeLanguageSpec): boolean {
  let index: number = from;
  while (index < line.length && isSpace(line.charCodeAt(index))) {
    index++;
  }
  const char: string = line.charAt(index);
  return char.length > 0 && language.keySeparators.includes(char);
}

/** Merges neighbouring spans of the same kind so a line draws few spans. */
function coalesce(spans: CodeSpan[]): CodeSpan[] {
  const merged: CodeSpan[] = [];
  for (const span of spans) {
    if (span.end <= span.start) {
      continue;
    }
    const last: CodeSpan | undefined = merged.length === 0 ? undefined : merged[merged.length - 1];
    if (last !== undefined && last.kind === span.kind && last.end === span.start) {
      last.end = span.end;
      continue;
    }
    merged.push({ start: span.start, end: span.end, kind: span.kind });
  }
  if (merged.length === 0) {
    return merged;
  }
  // A line always starts at column 0 so the leading gap draws as plain text.
  if (merged[0].start > 0) {
    merged.unshift({ start: 0, end: merged[0].start, kind: CodeTokenKind.Plain });
  }
  return merged;
}

/**
 * Normalizes line endings.
 *
 * The scanner walks a normalized copy, so a caller that slices the source by the
 * returned offsets must slice the same normalized text — a `\r\n` source would
 * otherwise shift every offset by one.
 */
export function normalizeCodeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Splits a source block into tokens, one entry per line. */
export function tokenizeCode(text: string, language: CodeLanguageSpec | null): CodeTokenization {
  const normalized: string = normalizeCodeText(text);
  const raw: string[] = normalized.split('\n');
  let truncated: boolean = raw.length > MAX_LINES;
  const count: number = truncated ? MAX_LINES : raw.length;
  const scanner: CodeScanner = new CodeScanner(language);
  const lines: CodeLine[] = [];
  let spanCount: number = 0;

  for (let index = 0; index < count; index++) {
    const line: string = raw[index];
    if (spanCount > MAX_SPANS) {
      truncated = true;
      lines.push({
        spans: line.length === 0
          ? []
          : [{ start: 0, end: line.length, kind: CodeTokenKind.Plain }],
        text: line,
      });
      continue;
    }
    const spans: CodeSpan[] = scanner.scan(line);
    spanCount += spans.length;
    lines.push({ spans: spans, text: line });
  }
  return { lines: lines, truncated: truncated };
}

/** Splits a bash fence into the commands Android shows one card per line. */
export function bashCommandLines(code: string): string[] {
  const normalized: string = normalizeCodeText(code);
  const commands: string[] = [];
  for (const line of normalized.split('\n')) {
    const trimmed: string = line.replace(/\s+$/, '');
    if (trimmed.trim().length > 0) {
      commands.push(trimmed);
    }
  }
  return commands;
}
