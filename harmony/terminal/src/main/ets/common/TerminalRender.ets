// Terminal rendering model for the Harmony client.
//
// Converts the emulator's cell grid into flat "chunk rows" that a List +
// LazyForEach can render lazily:
// - Each logical grid line is pre-wrapped ("chunked") into rows of at most
//   `chunkCols` cells so long lines stay visible without horizontal
//   scrolling, and background colors survive (Span has no background).
// - Scrollback rows are cached by absolute line index (the emulator's
//   monotonic scrollTotalCount) and keyed stably so LazyForEach reuses their
//   components; screen rows are rebuilt every refresh with a sequence number
//   in their key so content changes always re-render.

import { TerminalCell, TerminalLine, TerminalEmulator } from './TerminalEmulator';

export class TerminalSegment {
  text: string = '';
  fg: string = '';
  bg: string = '';
  bold: boolean = false;
}

export class TerminalChunkRow {
  key: string = '';
  segments: TerminalSegment[] = [];
}

export class TerminalChunkDataSource implements IDataSource {
  private rows: TerminalChunkRow[] = [];
  private listener: DataChangeListener | null = null;

  totalCount(): number {
    return this.rows.length;
  }

  getData(index: number): TerminalChunkRow {
    return this.rows[index];
  }

  registerDataChangeListener(listener: DataChangeListener): void {
    this.listener = listener;
  }

  unregisterDataChangeListener(listener: DataChangeListener): void {
    this.listener = null;
  }

  reload(rows: TerminalChunkRow[]): void {
    this.rows = rows;
    const listener = this.listener;
    if (listener !== null) {
      listener.onDataReloaded();
    }
  }
}

export class TerminalRenderBuilder {
  // Absolute line index -> chunk rows for that scrollback line.
  private cache: Map<number, TerminalChunkRow[]> = new Map();
  // Flattened, ordered chunk rows for every cached scrollback line.
  private scrollRows: TerminalChunkRow[] = [];
  // Half-open window [windowStart, windowEnd) of built absolute indices.
  private windowStart: number = 0;
  private windowEnd: number = 0;
  private lastChunkCols: number = -1;
  private lastThemeKey: string = '';
  // Bumped whenever cached rows are invalidated; embedded in keys so
  // LazyForEach rebuilds components instead of reusing stale ones.
  private generation: number = 0;

  buildRows(emulator: TerminalEmulator, chunkCols: number, themeFg: string, themeBg: string,
    cursorVisible: boolean, screenSeq: number): TerminalChunkRow[] {
    const themeKey = `${themeFg}|${themeBg}`;
    let fullRebuild = false;
    if (chunkCols !== this.lastChunkCols || themeKey !== this.lastThemeKey) {
      this.lastChunkCols = chunkCols;
      this.lastThemeKey = themeKey;
      this.generation++;
      this.cache.clear();
      fullRebuild = true;
    }
    this.syncScrollback(emulator, chunkCols, themeFg, themeBg, fullRebuild);
    const rows: TerminalChunkRow[] = this.scrollRows.slice(0);
    const screenCount = emulator.getScreenLineCount();
    const cursorRow = emulator.cursorRowNumber();
    const cursorCol = emulator.cursorColNumber();
    for (let r = 0; r < screenCount; r++) {
      const line = emulator.getScreenLine(r);
      const rowCursorCol = cursorVisible && r === cursorRow ? cursorCol : -1;
      const chunks = this.renderLineChunks(line, chunkCols, themeFg, themeBg, rowCursorCol,
        `sc_g${this.generation}_${r}`, screenSeq);
      for (let i = 0; i < chunks.length; i++) {
        rows.push(chunks[i]);
      }
    }
    return rows;
  }

  private syncScrollback(emulator: TerminalEmulator, chunkCols: number, themeFg: string,
    themeBg: string, fullRebuild: boolean): void {
    const total = emulator.scrollTotalCount();
    const count = emulator.getScrollbackCount();
    const base = total - count;
    if (fullRebuild) {
      this.scrollRows = [];
      this.windowStart = base;
      this.windowEnd = base;
    }
    // Evict absolute lines that dropped out of the scrollback window.
    while (this.windowStart < base && this.windowStart < this.windowEnd) {
      const chunks = this.cache.get(this.windowStart);
      if (chunks !== undefined) {
        for (let i = 0; i < chunks.length; i++) {
          this.scrollRows.shift();
        }
        this.cache.delete(this.windowStart);
      }
      this.windowStart++;
    }
    // Emulator reset (e.g. replay) can move the window forward past windowEnd.
    if (this.windowEnd < base) {
      this.windowEnd = base;
    }
    // Append any newly scrolled-off lines.
    while (this.windowEnd < base + count) {
      const abs = this.windowEnd;
      const line = emulator.getScrollbackLine(abs - base);
      const chunks = this.renderLineChunks(line, chunkCols, themeFg, themeBg, -1,
        `sb_g${this.generation}_${abs}`, 0);
      this.cache.set(abs, chunks);
      for (let i = 0; i < chunks.length; i++) {
        this.scrollRows.push(chunks[i]);
      }
      this.windowEnd++;
    }
  }

  private renderLineChunks(line: TerminalLine, chunkCols: number, themeFg: string, themeBg: string,
    cursorCol: number, keyPrefix: string, seq: number): TerminalChunkRow[] {
    const cells = line.cells;
    const width = cells.length;
    const chunks: TerminalChunkRow[] = [];
    if (width === 0) {
      const row = new TerminalChunkRow();
      row.key = `${keyPrefix}_c0_s${seq}`;
      row.segments = [makeSegment('\u00A0', themeFg, themeBg, false)];
      chunks.push(row);
      return chunks;
    }
    const effectiveCols = chunkCols > 0 ? chunkCols : width;
    let start = 0;
    while (start < width) {
      const end = Math.min(start + effectiveCols, width);
      const row = new TerminalChunkRow();
      const chunkIndex = Math.floor(start / effectiveCols);
      row.key = `${keyPrefix}_c${chunkIndex}_s${seq}`;
      row.segments = this.renderSegments(cells, start, end, themeFg, themeBg,
        cursorCol >= start && cursorCol < end ? cursorCol : -1);
      if (row.segments.length === 0) {
        // Fully-default chunk: keep one blank segment so the row keeps its height.
        row.segments = [makeSegment('\u00A0', themeFg, themeBg, false)];
      }
      chunks.push(row);
      start = end;
    }
    return chunks;
  }

  private renderSegments(cells: TerminalCell[], start: number, end: number, themeFg: string,
    themeBg: string, cursorCol: number): TerminalSegment[] {
    const segments: TerminalSegment[] = [];
    let text = '';
    let fg = '';
    let bg = '';
    let bold = false;
    let inRun = false;
    for (let i = start; i < end; i++) {
      const cell = cells[i];
      let cellFg = cell.fg.length > 0 ? cell.fg : themeFg;
      let cellBg = cell.bg.length > 0 ? cell.bg : themeBg;
      if (cell.inverse) {
        const swapped = cellFg;
        cellFg = cellBg;
        cellBg = swapped;
      }
      let cellBold = cell.bold;
      if (i === cursorCol) {
        // Block cursor: invert the cell against the theme colors.
        cellFg = themeBg;
        cellBg = themeFg;
        cellBold = false;
      }
      if (!inRun) {
        text = cell.text;
        fg = cellFg;
        bg = cellBg;
        bold = cellBold;
        inRun = true;
        continue;
      }
      if (cellFg === fg && cellBg === bg && cellBold === bold) {
        text += cell.text;
      } else {
        segments.push(makeSegment(text, fg, bg, bold));
        text = cell.text;
        fg = cellFg;
        bg = cellBg;
        bold = cellBold;
      }
    }
    if (inRun) {
      segments.push(makeSegment(text, fg, bg, bold));
    }
    return trimTrailingDefault(segments, themeFg, themeBg);
  }
}

function makeSegment(text: string, fg: string, bg: string, bold: boolean): TerminalSegment {
  const segment = new TerminalSegment();
  segment.text = text;
  segment.fg = fg;
  segment.bg = bg;
  segment.bold = bold;
  return segment;
}

// Drop trailing fully-default space segments so short lines do not paint
// trailing background tiles; always keeps at least one segment.
function trimTrailingDefault(segments: TerminalSegment[], themeFg: string,
  themeBg: string): TerminalSegment[] {
  const out = segments.slice(0);
  while (out.length > 1) {
    const seg = out[out.length - 1];
    if (seg.fg === themeFg && seg.bg === themeBg && !seg.bold && isAllSpaces(seg.text)) {
      out.pop();
    } else {
      break;
    }
  }
  return out;
}

function isAllSpaces(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) !== ' ') {
      return false;
    }
  }
  return true;
}
