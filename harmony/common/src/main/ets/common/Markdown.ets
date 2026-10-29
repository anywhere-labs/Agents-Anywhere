export interface MdSpan {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
  strike: boolean;
  linkUrl: string | null;
  path: string | null;
}

export interface MdBlock {
  kind: string;
  level: number;
  language: string;
  codeText: string;
  ordered: boolean;
  itemNumber: number;
  spans: MdSpan[];
  children: MdBlock[];
  table?: MdTable;
  taskChecked?: boolean;
}

export interface MdTable {
  header: string[];
  rows: string[][];
  aligns: string[];
}

interface MdHeadingMatch {
  level: number;
  rest: string;
}

interface MdListItemMatch {
  ordered: boolean;
  itemNumber: number;
  text: string;
}

interface MdLinkRun {
  url: string;
  next: number;
}

interface MdPathRun {
  path: string;
  next: number;
}

interface MdTaskMatch {
  checked: boolean;
  rest: string;
}

interface MdTableResult {
  block: MdBlock;
  nextIndex: number;
}

export function makeMdSpan(text: string): MdSpan {
  return {
    text: text,
    bold: false,
    italic: false,
    code: false,
    strike: false,
    linkUrl: null,
    path: null
  };
}

function newMdBlock(kind: string): MdBlock {
  return {
    kind: kind,
    level: 0,
    language: '',
    codeText: '',
    ordered: false,
    itemNumber: 0,
    spans: [],
    children: []
  };
}

export function mdTextHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return hash;
}

function indexOfWithin(text: string, needle: string, from: number, end: number): number {
  const found = text.indexOf(needle, from);
  if (found < 0 || found + needle.length > end) {
    return -1;
  }
  return found;
}

function isWordChar(ch: string): boolean {
  if (ch.length === 0) {
    return false;
  }
  return /[A-Za-z0-9_]/.test(ch);
}

function canOpenUnderscoreMarker(text: string, index: number, start: number): boolean {
  if (index <= start) {
    return true;
  }
  return !isWordChar(text.charAt(index - 1));
}

function isSupportedLinkUrl(url: string): boolean {
  const lowered = url.toLowerCase();
  return lowered.startsWith('http://') || lowered.startsWith('https://');
}

function collectUrlRun(text: string, index: number, end: number): string {
  let run = '';
  let pos = index;
  while (pos < end) {
    const ch = text.charAt(pos);
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '(' || ch === ')' ||
      ch === '<' || ch === '>' || ch === '[' || ch === ']') {
      break;
    }
    run += ch;
    pos++;
  }
  return run;
}

function trimTrailingPunctuation(text: string): string {
  let result = text;
  while (result.length > 1) {
    const last = result.charAt(result.length - 1);
    if (last === '.' || last === ',' || last === ';' || last === ':') {
      result = result.substring(0, result.length - 1);
    } else {
      break;
    }
  }
  return result;
}

function tryConsumeLink(text: string, index: number, end: number): MdLinkRun | null {
  if (index + 7 >= end) {
    return null;
  }
  const slice = text.substring(index, index + 8).toLowerCase();
  if (!slice.startsWith('http://') && !slice.startsWith('https://')) {
    return null;
  }
  const run = collectUrlRun(text, index, end);
  if (run.length <= 7) {
    return null;
  }
  return { url: run, next: index + run.length };
}

function pathRunAllowed(ch: string): boolean {
  return /[A-Za-z0-9_./~\-]/.test(ch);
}

function tryConsumePath(text: string, index: number, end: number): MdPathRun | null {
  const ch0 = text.charAt(index);
  let start = index;
  if (ch0 === '/') {
    start = index;
  } else if (ch0 === '.' && index + 1 < end && text.charAt(index + 1) === '/') {
    start = index;
  } else if (ch0 === '.' && index + 2 < end && text.charAt(index + 1) === '.' && text.charAt(index + 2) === '/') {
    start = index;
  } else if (ch0 === '~' && index + 1 < end && text.charAt(index + 1) === '/') {
    start = index;
  } else {
    return null;
  }
  let pos = start;
  let run = '';
  while (pos < end && pathRunAllowed(text.charAt(pos))) {
    run += text.charAt(pos);
    pos++;
  }
  if (run.length < 3 || run.indexOf('/') < 0) {
    return null;
  }
  const trimmed = trimTrailingPunctuation(run);
  if (trimmed.length < 2) {
    return null;
  }
  return { path: trimmed, next: start + trimmed.length };
}

function matchTaskMarker(text: string): MdTaskMatch | null {
  if (text.startsWith('[ ] ')) {
    return { checked: false, rest: text.substring(4).trim() };
  }
  if (text.startsWith('[x] ') || text.startsWith('[X] ')) {
    return { checked: true, rest: text.substring(4).trim() };
  }
  if (text === '[ ]' || text === '[x]' || text === '[X]') {
    return { checked: text !== '[ ]', rest: '' };
  }
  return null;
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) {
    trimmed = trimmed.substring(1);
  }
  if (trimmed.endsWith('|')) {
    trimmed = trimmed.substring(0, trimmed.length - 1);
  }
  const cells = trimmed.split('|');
  const result: string[] = [];
  for (const cell of cells) {
    result.push(cell.trim());
  }
  return result;
}

function isSeparatorRow(line: string): boolean {
  const cells = splitTableRow(line);
  if (cells.length < 1) {
    return false;
  }
  for (const cell of cells) {
    const content = cell.trim().replace(/:/g, '');
    if (content.length === 0 || !/^-+$/.test(content)) {
      return false;
    }
  }
  return true;
}

function parseAligns(separatorRow: string): string[] {
  const cells = splitTableRow(separatorRow);
  const aligns: string[] = [];
  for (const cell of cells) {
    const text = cell.trim();
    const content = text.replace(/:/g, '');
    if (content.length === 0 || /^-+$/.test(content)) {
      const left = text.startsWith(':');
      const right = text.endsWith(':');
      if (left && right) {
        aligns.push('center');
      } else if (right) {
        aligns.push('right');
      } else if (left) {
        aligns.push('left');
      } else {
        aligns.push('');
      }
    } else {
      aligns.push('');
    }
  }
  return aligns;
}

function tryParseGfmTable(lines: string[], index: number): MdTableResult | null {
  if (index + 1 >= lines.length) {
    return null;
  }
  const headerLine = lines[index].trim();
  if (!headerLine.includes('|')) {
    return null;
  }
  const separatorLine = lines[index + 1].trim();
  if (!isSeparatorRow(separatorLine)) {
    return null;
  }
  const header = splitTableRow(headerLine);
  const aligns = parseAligns(separatorLine);
  const rows: string[][] = [];
  let nextIndex = index + 2;
  while (nextIndex < lines.length) {
    const rowLine = lines[nextIndex].trim();
    if (rowLine.length === 0 || !rowLine.includes('|')) {
      break;
    }
    if (isSeparatorRow(rowLine)) {
      break;
    }
    rows.push(splitTableRow(rowLine));
    nextIndex++;
  }
  const table: MdTable = { header: header, rows: rows, aligns: aligns };
  const block = newMdBlock('table');
  block.table = table;
  return { block: block, nextIndex: nextIndex };
}

function pushPlainSpan(spans: MdSpan[], buffer: string): void {
  if (buffer.length === 0) {
    return;
  }
  spans.push(makeMdSpan(buffer));
}

export function parseInlineSpans(text: string): MdSpan[] {
  return parseInlineRange(text, 0, text.length);
}

function parseInlineRange(text: string, start: number, end: number): MdSpan[] {
  const spans: MdSpan[] = [];
  let buffer = '';
  let index = start;
  while (index < end) {
    const ch = text.charAt(index);
    if (ch === '\\' && index + 1 < end) {
      const next = text.charAt(index + 1);
      if (next === '\\' || next === '*' || next === '_' || next === '`' || next === '~' ||
        next === '[' || next === ']' || next === '(' || next === ')' || next === '#' || next === '>') {
        buffer += next;
        index += 2;
        continue;
      }
    }
    if (ch === '`') {
      const closing = indexOfWithin(text, '`', index + 1, end);
      if (closing > index + 1) {
        pushPlainSpan(spans, buffer);
        buffer = '';
        const innerText = text.substring(index + 1, closing);
        const codeSpan = makeMdSpan(innerText);
        codeSpan.code = true;
        if (tryConsumePath(innerText, 0, innerText.length) !== null) {
          codeSpan.path = innerText;
        }
        spans.push(codeSpan);
        index = closing + 1;
        continue;
      }
    }
    if (ch === '~' && text.charAt(index + 1) === '~') {
      const closing = indexOfWithin(text, '~~', index + 2, end);
      if (closing > index + 2) {
        pushPlainSpan(spans, buffer);
        buffer = '';
        const inner = parseInlineRange(text, index + 2, closing);
        for (const innerSpan of inner) {
          innerSpan.strike = true;
          spans.push(innerSpan);
        }
        index = closing + 2;
        continue;
      }
    }
    if (ch === '*' || ch === '_') {
      if (text.charAt(index + 1) === ch && (ch === '*' || canOpenUnderscoreMarker(text, index, start))) {
        const closing = indexOfWithin(text, ch + ch, index + 2, end);
        if (closing > index + 2) {
          pushPlainSpan(spans, buffer);
          buffer = '';
          const inner = parseInlineRange(text, index + 2, closing);
          for (const innerSpan of inner) {
            innerSpan.bold = true;
            spans.push(innerSpan);
          }
          index = closing + 2;
          continue;
        }
      }
      if (ch === '_' && !canOpenUnderscoreMarker(text, index, start)) {
        buffer += ch;
        index++;
        continue;
      }
      const closingSingle = indexOfWithin(text, ch, index + 1, end);
      if (closingSingle > index + 1) {
        if (ch === '_' && closingSingle + 1 < end && isWordChar(text.charAt(closingSingle + 1))) {
          buffer += ch;
          index++;
          continue;
        }
        pushPlainSpan(spans, buffer);
        buffer = '';
        const inner = parseInlineRange(text, index + 1, closingSingle);
        for (const innerSpan of inner) {
          innerSpan.italic = true;
          spans.push(innerSpan);
        }
        index = closingSingle + 1;
        continue;
      }
      buffer += ch;
      index++;
      continue;
    }
    if (ch === '[') {
      const closeBracket = indexOfWithin(text, ']', index + 1, end);
      if (closeBracket > index + 1 && closeBracket + 1 < end && text.charAt(closeBracket + 1) === '(') {
        const closeParen = indexOfWithin(text, ')', closeBracket + 2, end);
        if (closeParen > closeBracket + 2) {
          const label = text.substring(index + 1, closeBracket);
          const url = text.substring(closeBracket + 2, closeParen);
          if (isSupportedLinkUrl(url)) {
            pushPlainSpan(spans, buffer);
            buffer = '';
            const labelSpans = parseInlineSpans(label);
            for (const labelSpan of labelSpans) {
              labelSpan.linkUrl = url;
              spans.push(labelSpan);
            }
            index = closeParen + 1;
            continue;
          }
        }
      }
    }
    const link = tryConsumeLink(text, index, end);
    if (link !== null) {
      pushPlainSpan(spans, buffer);
      buffer = '';
      const urlSpan = makeMdSpan(link.url);
      urlSpan.linkUrl = link.url;
      spans.push(urlSpan);
      index = link.next;
      continue;
    }
    if (ch !== '`' && ch !== '[' && ch !== '(' && ch !== ')') {
      const path = tryConsumePath(text, index, end);
      if (path !== null) {
        pushPlainSpan(spans, buffer);
        buffer = '';
        const pathSpan = makeMdSpan(path.path);
        pathSpan.path = path.path;
        spans.push(pathSpan);
        index = path.next;
        continue;
      }
    }
    buffer += ch;
    index++;
  }
  pushPlainSpan(spans, buffer);
  return spans;
}

function matchMdHeading(line: string): MdHeadingMatch | null {
  if (!line.startsWith('#')) {
    return null;
  }
  let level = 0;
  while (level < line.length && level < 6 && line.charAt(level) === '#') {
    level++;
  }
  if (level === 0) {
    return null;
  }
  let rest = line.substring(level);
  if (!rest.startsWith(' ') && !rest.startsWith('\t')) {
    return null;
  }
  rest = rest.trim();
  if (rest.length === 0) {
    return null;
  }
  const match: MdHeadingMatch = { level: level, rest: rest };
  return match;
}

function isMdRuleLine(line: string): boolean {
  if (line.length < 3) {
    return false;
  }
  const first = line.charAt(0);
  if (first !== '-' && first !== '*' && first !== '_') {
    return false;
  }
  for (let i = 0; i < line.length; i++) {
    if (line.charAt(i) !== first) {
      return false;
    }
  }
  return true;
}

function matchMdListItem(line: string): MdListItemMatch | null {
  if (line.startsWith('- ') || line.startsWith('* ') || line.startsWith('+ ')) {
    const match: MdListItemMatch = { ordered: false, itemNumber: 0, text: line.substring(2).trim() };
    return match;
  }
  let digits = '';
  let pos = 0;
  while (pos < line.length && line.charAt(pos) >= '0' && line.charAt(pos) <= '9') {
    digits += line.charAt(pos);
    pos++;
  }
  if (digits.length === 0 || digits.length > 9) {
    return null;
  }
  if (pos >= line.length) {
    return null;
  }
  const marker = line.charAt(pos);
  if (marker !== '.' && marker !== ')') {
    return null;
  }
  pos++;
  if (pos >= line.length || line.charAt(pos) !== ' ') {
    return null;
  }
  const text = line.substring(pos).trim();
  const match: MdListItemMatch = { ordered: true, itemNumber: Number(digits), text: text };
  return match;
}

export function parseMarkdownBlocks(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  if (text.length === 0) {
    return blocks;
  }
  const lines = text.split('\n');
  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (trimmed.length === 0) {
      index++;
      continue;
    }
    if (trimmed.startsWith('```')) {
      const language = trimmed.substring(3).trim();
      const codeLines: string[] = [];
      index++;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index++;
      }
      if (index < lines.length) {
        index++;
      }
      const block = newMdBlock('code');
      block.language = language;
      block.codeText = codeLines.join('\n');
      blocks.push(block);
      continue;
    }
    const heading = matchMdHeading(trimmed);
    if (heading !== null) {
      const block = newMdBlock('heading');
      block.level = heading.level;
      block.spans = parseInlineSpans(heading.rest);
      for (const span of block.spans) {
        span.bold = true;
      }
      blocks.push(block);
      index++;
      continue;
    }
    if (isMdRuleLine(trimmed)) {
      blocks.push(newMdBlock('rule'));
      index++;
      continue;
    }
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const quoteTrimmed = lines[index].trim();
        if (!quoteTrimmed.startsWith('>')) {
          break;
        }
        let rest = quoteTrimmed.substring(1);
        if (rest.startsWith(' ')) {
          rest = rest.substring(1);
        }
        quoteLines.push(rest);
        index++;
      }
      const block = newMdBlock('quote');
      block.children = parseMarkdownBlocks(quoteLines.join('\n'));
      blocks.push(block);
      continue;
    }
    if (matchMdListItem(trimmed) !== null) {
      while (index < lines.length) {
        const item = matchMdListItem(lines[index].trim());
        if (item === null) {
          break;
        }
        const block = newMdBlock('listItem');
        block.ordered = item.ordered;
        block.itemNumber = item.itemNumber;
        const task = matchTaskMarker(item.text);
        if (task !== null) {
          block.taskChecked = task.checked;
          block.spans = parseInlineSpans(task.rest);
        } else {
          block.spans = parseInlineSpans(item.text);
        }
        blocks.push(block);
        index++;
      }
      continue;
    }
    const tableResult = tryParseGfmTable(lines, index);
    if (tableResult !== null) {
      blocks.push(tableResult.block);
      index = tableResult.nextIndex;
      continue;
    }
    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const current = lines[index].trim();
      if (current.length === 0 || current.startsWith('```') || current.startsWith('>')) {
        break;
      }
      if (matchMdHeading(current) !== null || isMdRuleLine(current) || matchMdListItem(current) !== null) {
        break;
      }
      paragraphLines.push(current);
      index++;
    }
    if (paragraphLines.length > 0) {
      const block = newMdBlock('paragraph');
      block.spans = parseInlineSpans(paragraphLines.join('\n'));
      blocks.push(block);
    }
  }
  return blocks;
}
