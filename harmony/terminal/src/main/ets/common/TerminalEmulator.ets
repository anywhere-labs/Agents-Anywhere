// ANSI/VT100-style terminal emulator for the Harmony client.
// Keeps a cell grid (cols x rows) with cursor, scrollback, and full SGR
// color attributes (16/256/truecolor, bold, inverse). Mirrors the surface of
// android's RemoteTerminalController: feed() appends remote bytes, resize()
// reflows the screen buffer, and the resize frame protocol
// ({type:"resize",cols,rows}) is emitted by the caller.
// Rendering happens in TerminalPage through the TerminalRender builder.

// Classic xterm/VGA 16-color palette (Termux defaults).
const ANSI_COLORS: string[] = [
  '#000000', '#CD0000', '#00CD00', '#CDCD00',
  '#0000EE', '#CD00CD', '#00CDCD', '#E5E5E5',
  '#7F7F7F', '#FF0000', '#00FF00', '#FFFF00',
  '#5C5CFF', '#FF00FF', '#00FFFF', '#FFFFFF'
];

// 6x6x6 color cube channel levels for the 256-color palette.
const CUBE_LEVELS: number[] = [0, 95, 135, 175, 215, 255];

export class TerminalCell {
  text: string = ' ';
  fg: string = ''; // '' = default foreground (theme terminal text color)
  bg: string = ''; // '' = default background (theme terminal background)
  bold: boolean = false;
  inverse: boolean = false;
}

export class TerminalLine {
  cells: TerminalCell[] = [];

  constructor(cols: number) {
    this.cells = new Array<TerminalCell>(cols);
    for (let i = 0; i < cols; i++) {
      this.cells[i] = new TerminalCell();
    }
  }
}

export class TerminalEmulator {
  cols: number;
  rows: number;
  private lines: TerminalLine[] = [];
  private scrollback: TerminalLine[] = [];
  private cursorRow: number = 0;
  private cursorCol: number = 0;
  private wrapPending: boolean = false;
  private fg: string = '';
  private bg: string = '';
  private bold: boolean = false;
  private inverse: boolean = false;
  private cursorVisible: boolean = true;
  private maxScrollback: number;
  // Monotonic count of lines ever scrolled off the screen; never reset so
  // render caches can key scrollback rows by absolute line index.
  private totalScrolled: number = 0;
  private buffer: string = '';
  // 0 none, 1 after ESC, 2 CSI params, 3 OSC payload, 4 charset designator.
  private escapeState: number = 0;
  private csiPrivate: boolean = false;
  private savedRow: number = 0;
  private savedCol: number = 0;

  constructor(cols: number, rows: number, maxScrollback: number) {
    this.cols = cols;
    this.rows = rows;
    this.maxScrollback = maxScrollback;
    this.lines = new Array<TerminalLine>(rows);
    for (let i = 0; i < rows; i++) {
      this.lines[i] = new TerminalLine(cols);
    }
  }

  reset(): void {
    this.lines = new Array<TerminalLine>(this.rows);
    for (let i = 0; i < this.rows; i++) {
      this.lines[i] = new TerminalLine(this.cols);
    }
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.wrapPending = false;
    this.fg = '';
    this.bg = '';
    this.bold = false;
    this.inverse = false;
    this.cursorVisible = true;
    this.scrollback = [];
    this.buffer = '';
    this.escapeState = 0;
    this.csiPrivate = false;
  }

  resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0 || (cols === this.cols && rows === this.rows)) {
      return;
    }
    const oldLines = this.lines;
    const oldRows = this.rows;
    this.cols = cols;
    this.rows = rows;
    this.lines = new Array<TerminalLine>(rows);
    for (let r = 0; r < rows; r++) {
      this.lines[r] = new TerminalLine(cols);
      if (r < oldRows && oldLines[r] !== undefined) {
        const old = oldLines[r];
        for (let c = 0; c < cols; c++) {
          if (c < old.cells.length) {
            this.lines[r].cells[c] = old.cells[c];
          }
        }
      }
    }
    this.cursorRow = Math.min(this.cursorRow, rows - 1);
    this.cursorCol = Math.min(this.cursorCol, cols - 1);
    this.wrapPending = false;
  }

  feed(chunk: string): void {
    let i = 0;
    while (i < chunk.length) {
      const code = chunk.charCodeAt(i);
      // Combine UTF-16 surrogate pairs into a single cell (CJK/emoji).
      if (this.escapeState === 0 && code >= 0xD800 && code <= 0xDBFF && i + 1 < chunk.length) {
        const low = chunk.charCodeAt(i + 1);
        if (low >= 0xDC00 && low <= 0xDFFF) {
          this.putChar(chunk.substring(i, i + 2));
          i += 2;
          continue;
        }
      }
      this.processChar(chunk.charCodeAt(i));
      i++;
    }
  }

  // --- Read access for the renderer ---

  getScreenLineCount(): number {
    return this.lines.length;
  }

  getScreenLine(row: number): TerminalLine {
    return this.lines[row];
  }

  getScrollbackCount(): number {
    return this.scrollback.length;
  }

  getScrollbackLine(index: number): TerminalLine {
    return this.scrollback[index];
  }

  scrollTotalCount(): number {
    return this.totalScrolled;
  }

  clearScreen(): void {
    this.eraseInScreen(2);
    this.scrollback = [];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.wrapPending = false;
  }

  isCursorVisible(): boolean {
    return this.cursorVisible;
  }

  cursorRowNumber(): number {
    return this.cursorRow;
  }

  cursorColNumber(): number {
    return this.cursorCol;
  }

  // --- Input processing ---

  private processChar(code: number): void {
    if (this.escapeState === 1) {
      this.escapeState = 0;
      if (code === '['.charCodeAt(0)) {
        this.escapeState = 2;
        this.csiPrivate = false;
      } else if (code === ']'.charCodeAt(0)) {
        this.escapeState = 3; // consume OSC until BEL, ST, or ESC\
      } else if (code === '('.charCodeAt(0) || code === ')'.charCodeAt(0) ||
        code === '*'.charCodeAt(0) || code === '+'.charCodeAt(0)) {
        this.escapeState = 4; // charset designator: consume the next byte
      } else if (code === 'M'.charCodeAt(0)) {
        this.reverseIndex();
      } else if (code === 'D'.charCodeAt(0)) {
        this.index();
      } else if (code === 'E'.charCodeAt(0)) {
        this.cursorCol = 0;
        this.index();
      } else if (code === '7'.charCodeAt(0)) {
        this.savedRow = this.cursorRow;
        this.savedCol = this.cursorCol;
      } else if (code === '8'.charCodeAt(0)) {
        this.cursorRow = this.clampRow(this.savedRow);
        this.cursorCol = this.clampCol(this.savedCol);
      } else if (code === 'c'.charCodeAt(0)) {
        this.reset();
      }
      // '=' / '>' (keypad modes) and unknown finals: ignored.
      return;
    }
    if (this.escapeState === 2) {
      // CSI sequence: buffer parameters, act on the final byte.
      if (code >= '0'.charCodeAt(0) && code <= '9'.charCodeAt(0)) {
        this.buffer += String.fromCharCode(code);
        return;
      }
      if (code === ';'.charCodeAt(0)) {
        this.buffer += ';';
        return;
      }
      if (code === '?'.charCodeAt(0) || code === '>'.charCodeAt(0) || code === '<'.charCodeAt(0) ||
        code === '='.charCodeAt(0)) {
        this.csiPrivate = true;
        return;
      }
      if (code >= 0x20 && code <= 0x2f) {
        // Intermediate bytes: treat the sequence as ignorable.
        this.csiPrivate = true;
        return;
      }
      const param = this.buffer;
      this.buffer = '';
      const isPrivate = this.csiPrivate;
      this.csiPrivate = false;
      this.escapeState = 0;
      this.handleCsi(param, code, isPrivate);
      return;
    }
    if (this.escapeState === 3) {
      if (code === 0x07 || code === 0x9c || code === '\\'.charCodeAt(0)) {
        this.escapeState = 0;
      }
      return;
    }
    if (this.escapeState === 4) {
      this.escapeState = 0; // consume the charset designator final byte
      return;
    }
    if (code === 0x1b) {
      this.escapeState = 1;
      return;
    }
    if (code === 0x07) {
      return; // bell: ignore
    }
    if (code === 0x08) {
      // backspace
      if (this.cursorCol > 0) {
        this.cursorCol--;
      }
      return;
    }
    if (code === 0x09) {
      this.cursorCol = this.nextTabStop();
      return;
    }
    if (code === 0x0a || code === 0x0b || code === 0x0c) {
      this.newLine();
      return;
    }
    if (code === 0x0d) {
      this.cursorCol = 0;
      return;
    }
    if (code === 0x0e || code === 0x0f) {
      return; // SO/SI charset shifts: ignore
    }
    if (code >= 0x20) {
      this.putChar(String.fromCharCode(code));
    }
  }

  private handleCsi(param: string, final: number, isPrivate: boolean): void {
    if (isPrivate) {
      // DEC private modes: only cursor visibility is tracked.
      if (param === '25') {
        if (final === 'h'.charCodeAt(0)) {
          this.cursorVisible = true;
        } else if (final === 'l'.charCodeAt(0)) {
          this.cursorVisible = false;
        }
      }
      return;
    }
    if (final === 'm'.charCodeAt(0)) {
      this.applySgr(param);
      return;
    }
    if (final === 'H'.charCodeAt(0) || final === 'f'.charCodeAt(0)) {
      const parts = param === '' ? ['1', '1'] : param.split(';');
      this.cursorRow = this.clampRow(parseIntOr(parts[0], 1) - 1);
      this.cursorCol = this.clampCol(parseIntOr(parts.length > 1 ? parts[1] : '1', 1) - 1);
      this.wrapPending = false;
      return;
    }
    if (final === 'A'.charCodeAt(0)) {
      this.cursorRow = this.clampRow(this.cursorRow - parseIntOr(param, 1));
      return;
    }
    if (final === 'B'.charCodeAt(0)) {
      this.cursorRow = this.clampRow(this.cursorRow + parseIntOr(param, 1));
      return;
    }
    if (final === 'C'.charCodeAt(0)) {
      this.cursorCol = this.clampCol(this.cursorCol + parseIntOr(param, 1));
      return;
    }
    if (final === 'D'.charCodeAt(0)) {
      this.cursorCol = this.clampCol(this.cursorCol - parseIntOr(param, 1));
      return;
    }
    if (final === 'G'.charCodeAt(0)) {
      this.cursorCol = this.clampCol(parseIntOr(param, 1) - 1);
      return;
    }
    if (final === 'd'.charCodeAt(0)) {
      this.cursorRow = this.clampRow(parseIntOr(param, 1) - 1);
      return;
    }
    if (final === 'J'.charCodeAt(0)) {
      this.eraseInScreen(parseIntOr(param, 0));
      return;
    }
    if (final === 'K'.charCodeAt(0)) {
      this.eraseInLine(parseIntOr(param, 0));
      return;
    }
    if (final === 'L'.charCodeAt(0)) {
      this.insertLines(parseIntOr(param, 1));
      return;
    }
    if (final === 'M'.charCodeAt(0)) {
      this.deleteLines(parseIntOr(param, 1));
      return;
    }
    if (final === '@'.charCodeAt(0)) {
      this.insertChars(parseIntOr(param, 1));
      return;
    }
    if (final === 'P'.charCodeAt(0)) {
      this.deleteChars(parseIntOr(param, 1));
      return;
    }
    if (final === 'X'.charCodeAt(0)) {
      this.eraseChars(parseIntOr(param, 1));
      return;
    }
    if (final === 's'.charCodeAt(0)) {
      this.savedRow = this.cursorRow;
      this.savedCol = this.cursorCol;
      return;
    }
    if (final === 'u'.charCodeAt(0)) {
      this.cursorRow = this.clampRow(this.savedRow);
      this.cursorCol = this.clampCol(this.savedCol);
      return;
    }
    // Other CSI sequences (scroll regions, modes, …) are intentionally
    // ignored; the grid model keeps the session usable without them.
  }

  // --- SGR (select graphic rendition) ---

  private applySgr(param: string): void {
    const codes: number[] = param === '' ? [0] : param.split(';').map((p: string): number => parseIntOr(p, 0));
    let i = 0;
    while (i < codes.length) {
      const code = codes[i];
      if (code === 38 || code === 48) {
        // Extended color: 38;5;n (256-color) or 38;2;r;g;b (truecolor).
        const mode = i + 1 < codes.length ? codes[i + 1] : -1;
        if (mode === 5) {
          const n = i + 2 < codes.length ? codes[i + 2] : 0;
          const color = color256(n);
          if (code === 38) {
            this.fg = color;
          } else {
            this.bg = color;
          }
          i += 3;
        } else if (mode === 2) {
          const r = i + 2 < codes.length ? codes[i + 2] : 0;
          const g = i + 3 < codes.length ? codes[i + 3] : 0;
          const b = i + 4 < codes.length ? codes[i + 4] : 0;
          const color = rgbHex(r, g, b);
          if (code === 38) {
            this.fg = color;
          } else {
            this.bg = color;
          }
          i += 5;
        } else {
          i += 2; // malformed extended color: skip mode byte
        }
        continue;
      }
      this.applySgrCode(code);
      i++;
    }
  }

  private applySgrCode(code: number): void {
    if (code === 0) {
      this.fg = '';
      this.bg = '';
      this.bold = false;
      this.inverse = false;
      return;
    }
    if (code === 1) {
      this.bold = true;
      return;
    }
    if (code === 7) {
      this.inverse = true;
      return;
    }
    if (code === 22) {
      this.bold = false;
      return;
    }
    if (code === 27) {
      this.inverse = false;
      return;
    }
    if (code >= 30 && code <= 37) {
      this.fg = ANSI_COLORS[code - 30];
      return;
    }
    if (code === 39) {
      this.fg = '';
      return;
    }
    if (code >= 40 && code <= 47) {
      this.bg = ANSI_COLORS[code - 40];
      return;
    }
    if (code === 49) {
      this.bg = '';
      return;
    }
    if (code >= 90 && code <= 97) {
      this.fg = ANSI_COLORS[8 + code - 90];
      return;
    }
    if (code >= 100 && code <= 107) {
      this.bg = ANSI_COLORS[8 + code - 100];
      return;
    }
  }

  // --- Grid mutation ---

  private putChar(text: string): void {
    if (this.wrapPending && this.cursorCol > 0) {
      this.cursorCol = 0;
      this.index();
      this.wrapPending = false;
    }
    const cell = this.lines[this.cursorRow].cells[this.cursorCol];
    cell.text = text;
    cell.fg = this.fg;
    cell.bg = this.bg;
    cell.bold = this.bold;
    cell.inverse = this.inverse;
    this.cursorCol++;
    if (this.cursorCol >= this.cols) {
      this.cursorCol = this.cols; // deferred wrap
      this.wrapPending = true;
    }
  }

  private index(): void {
    if (this.cursorRow < this.rows - 1) {
      this.cursorRow++;
    } else {
      this.scrollLine();
    }
  }

  private newLine(): void {
    this.index();
    this.cursorCol = 0;
  }

  private scrollLine(): void {
    const scrolled = this.lines.shift();
    this.lines.push(new TerminalLine(this.cols));
    this.totalScrolled++;
    if (scrolled !== undefined) {
      this.scrollback.push(scrolled);
      if (this.scrollback.length > this.maxScrollback) {
        this.scrollback.shift();
      }
    }
  }

  private reverseIndex(): void {
    if (this.cursorRow > 0) {
      this.cursorRow--;
    } else {
      this.lines.pop();
      this.lines.unshift(new TerminalLine(this.cols));
    }
  }

  private nextTabStop(): number {
    const next = ((this.cursorCol + 8) / 8) * 8;
    return Math.min(next, this.cols - 1);
  }

  private eraseInScreen(mode: number): void {
    if (mode === 0) {
      this.eraseInLine(0);
      for (let r = this.cursorRow + 1; r < this.rows; r++) {
        this.lines[r] = this.erasedLine();
      }
    } else if (mode === 1) {
      for (let r = 0; r < this.cursorRow; r++) {
        this.lines[r] = this.erasedLine();
      }
      this.eraseInLine(0);
    } else if (mode === 2) {
      for (let r = 0; r < this.rows; r++) {
        this.lines[r] = this.erasedLine();
      }
    } else if (mode === 3) {
      // CSI 3J: erase the saved scrollback only (xterm E3).
      this.scrollback = [];
    }
  }

  private eraseInLine(mode: number): void {
    const line = this.lines[this.cursorRow];
    if (mode === 0) {
      for (let c = this.cursorCol; c < this.cols; c++) {
        this.eraseCellAt(line, c);
      }
    } else if (mode === 1) {
      for (let c = 0; c <= this.cursorCol && c < this.cols; c++) {
        this.eraseCellAt(line, c);
      }
    } else {
      for (let c = 0; c < this.cols; c++) {
        this.eraseCellAt(line, c);
      }
    }
  }

  private eraseChars(count: number): void {
    const line = this.lines[this.cursorRow];
    const n = Math.min(Math.max(count, 1), this.cols - this.cursorCol);
    for (let i = 0; i < n; i++) {
      this.eraseCellAt(line, this.cursorCol + i);
    }
  }

  private insertLines(count: number): void {
    const n = Math.min(Math.max(count, 1), this.rows - this.cursorRow);
    for (let i = 0; i < n; i++) {
      this.lines.splice(this.cursorRow, 0, new TerminalLine(this.cols));
      this.lines.pop();
    }
  }

  private deleteLines(count: number): void {
    const n = Math.min(Math.max(count, 1), this.rows - this.cursorRow);
    for (let i = 0; i < n; i++) {
      this.lines.splice(this.cursorRow, 1);
      this.lines.push(new TerminalLine(this.cols));
    }
  }

  private insertChars(count: number): void {
    const line = this.lines[this.cursorRow];
    const n = Math.min(Math.max(count, 1), this.cols - this.cursorCol);
    for (let i = 0; i < n; i++) {
      line.cells.splice(this.cursorCol, 0, new TerminalCell());
    }
    const excess = line.cells.length - this.cols;
    if (excess > 0) {
      line.cells.splice(this.cols, excess);
    }
  }

  private deleteChars(count: number): void {
    const line = this.lines[this.cursorRow];
    const n = Math.min(Math.max(count, 1), this.cols - this.cursorCol);
    line.cells.splice(this.cursorCol, n);
    for (let i = 0; i < n; i++) {
      line.cells.push(new TerminalCell());
    }
  }

  private erasedLine(): TerminalLine {
    const line = new TerminalLine(this.cols);
    if (this.bg.length > 0) {
      for (let c = 0; c < this.cols; c++) {
        line.cells[c].bg = this.bg;
      }
    }
    return line;
  }

  private eraseCellAt(line: TerminalLine, col: number): void {
    const cell = line.cells[col];
    cell.text = ' ';
    cell.fg = '';
    cell.bg = this.bg;
    cell.bold = false;
    cell.inverse = false;
  }

  private clampRow(row: number): number {
    return Math.max(0, Math.min(row, this.rows - 1));
  }

  private clampCol(col: number): number {
    return Math.max(0, Math.min(col, this.cols - 1));
  }
}

function parseIntOr(value: string, fallback: number): number {
  if (value.length === 0) {
    return fallback;
  }
  const parsed = parseInt(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function toHex2(value: number): string {
  const clamped = Math.min(255, Math.max(0, Math.round(value)));
  const hex = clamped.toString(16).toUpperCase();
  return hex.length === 1 ? `0${hex}` : hex;
}

function rgbHex(r: number, g: number, b: number): string {
  return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
}

// Standard xterm 256-color palette: 0-15 system colors, 16-231 6x6x6 color
// cube, 232-255 24-step grayscale ramp.
function color256(n: number): string {
  const idx = n < 0 ? 0 : (n > 255 ? 255 : n);
  if (idx < 16) {
    return ANSI_COLORS[idx];
  }
  if (idx < 232) {
    const i = idx - 16;
    const r = CUBE_LEVELS[Math.floor(i / 36) % 6];
    const g = CUBE_LEVELS[Math.floor(i / 6) % 6];
    const b = CUBE_LEVELS[i % 6];
    return rgbHex(r, g, b);
  }
  const gray = 8 + (idx - 232) * 10;
  return rgbHex(gray, gray, gray);
}
