import { Fragment, type CSSProperties, type ReactNode } from "react";

// Minimal ANSI SGR → React renderer for command output. Command tools (Bash)
// often emit colored output; rendered raw it shows escape-code garbage like
// "\x1b[0;32m". We parse the common SGR sequences into styled <span>s and
// drop the rest (cursor moves, OSC titles) so the block reads like a terminal.

// 16-colour palette tuned for a dark output panel.
const FG: Record<number, string> = {
  30: "#5c6370",
  31: "#e06c75",
  32: "#98c379",
  33: "#e5c07b",
  34: "#61afef",
  35: "#c678dd",
  36: "#56b6c2",
  37: "#cdd3de",
  90: "#7f848e",
  91: "#f08d98",
  92: "#b5e08c",
  93: "#f0d8a8",
  94: "#8bc4f5",
  95: "#d7a3e8",
  96: "#7fd4de",
  97: "#ffffff",
};

const BG: Record<number, string> = {
  40: "#1b1f27",
  41: "#e06c75",
  42: "#98c379",
  43: "#e5c07b",
  44: "#61afef",
  45: "#c678dd",
  46: "#56b6c2",
  47: "#abb2bf",
  100: "#3a3f4b",
  101: "#f08d98",
  102: "#b5e08c",
  103: "#f0d8a8",
  104: "#8bc4f5",
  105: "#d7a3e8",
  106: "#7fd4de",
  107: "#ffffff",
};

type SgrState = {
  color?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
};

const RESET: SgrState = {};

function applySgr(state: SgrState, params: number[]): SgrState {
  const next: SgrState = { ...state };
  // No params (e.g. ESC[m) is a reset.
  if (params.length === 0) return { ...RESET };
  for (let i = 0; i < params.length; i++) {
    const code = params[i]!;
    if (code === 0) {
      Object.assign(next, RESET);
      for (const k of Object.keys(next) as (keyof SgrState)[]) delete next[k];
    } else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 39) delete next.color;
    else if (code === 49) delete next.background;
    else if (FG[code]) next.color = FG[code];
    else if (BG[code]) next.background = BG[code];
    else if (code === 38 || code === 48) {
      // Extended colour: 38;5;n / 48;5;n (256) or 38;2;r;g;b (truecolor).
      const target = code === 38 ? "color" : "background";
      const mode = params[i + 1];
      if (mode === 5 && params[i + 2] != null) {
        next[target] = ansi256(params[i + 2]!);
        i += 2;
      } else if (mode === 2 && params[i + 4] != null) {
        next[target] = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
        i += 4;
      }
    }
  }
  return next;
}

function ansi256(n: number): string {
  if (n < 16) {
    return FG[n < 8 ? 30 + n : 90 + (n - 8)] ?? "#cdd3de";
  }
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const c = n - 16;
  const r = Math.floor(c / 36);
  const g = Math.floor((c % 36) / 6);
  const b = c % 6;
  const ch = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${ch(r)},${ch(g)},${ch(b)})`;
}

function styleOf(state: SgrState): CSSProperties {
  const css: CSSProperties = {};
  if (state.color) css.color = state.color;
  if (state.background) css.background = state.background;
  if (state.bold) css.fontWeight = 600;
  if (state.dim) css.opacity = 0.7;
  if (state.italic) css.fontStyle = "italic";
  if (state.underline) css.textDecoration = "underline";
  return css;
}

// Emulate carriage-return overwrites (progress bars): within each newline-
// delimited line, keep only the text after the final bare `\r`.
function collapseCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .split("\n")
    .map((line) => {
      const segments = line.split("\r");
      return segments[segments.length - 1] ?? "";
    })
    .join("\n");
}

type Run = { text: string; style: SgrState };

function parse(input: string): Run[] {
  const runs: Run[] = [];
  let state: SgrState = {};
  let buffer = "";
  let i = 0;
  const flush = () => {
    if (buffer) {
      runs.push({ text: buffer, style: state });
      buffer = "";
    }
  };
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === "\x1b") {
      const seq = input[i + 1];
      if (seq === "[") {
        // CSI: ESC [ params... finalByte
        let j = i + 2;
        let paramStr = "";
        while (j < input.length && /[0-9;?]/.test(input[j]!)) {
          paramStr += input[j]!;
          j++;
        }
        const finalByte = input[j];
        if (finalByte === "m") {
          flush();
          const params = paramStr
            .split(";")
            .filter((p) => p !== "")
            .map((p) => Number.parseInt(p, 10))
            .filter((n) => !Number.isNaN(n));
          state = applySgr(state, params);
        }
        // Any other final byte (cursor move, erase, …) is dropped.
        i = j + 1;
        continue;
      }
      if (seq === "]") {
        // OSC: ESC ] ... (BEL | ESC \) — strip (e.g. window title).
        let j = i + 2;
        while (j < input.length && input[j] !== "\x07") {
          if (input[j] === "\x1b" && input[j + 1] === "\\") {
            j++;
            break;
          }
          j++;
        }
        i = j + 1;
        continue;
      }
      // Lone/other escape — skip the ESC and the following byte.
      i += 2;
      continue;
    }
    buffer += ch;
    i++;
  }
  flush();
  return runs;
}

export function AnsiText({ text }: { text: string }): ReactNode {
  const runs = parse(collapseCarriageReturns(text));
  // Fast path: no styling at all — return the plain string.
  if (runs.every((r) => Object.keys(r.style).length === 0)) {
    return runs.map((r) => r.text).join("");
  }
  return runs.map((run, idx) => {
    const css = styleOf(run.style);
    if (Object.keys(css).length === 0) {
      return <Fragment key={idx}>{run.text}</Fragment>;
    }
    return (
      <span key={idx} style={css}>
        {run.text}
      </span>
    );
  });
}
