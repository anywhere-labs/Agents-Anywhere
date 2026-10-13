import { TimelineFileChange } from '../../api/TimelineDtos';

/**
 * Unified-diff preview.
 *
 * Port of `diffPreview` in `ui/screens/sessiondetail/DiffPreviewParser.kt`.
 *
 * The Android implementation throws away the git preamble (which the UI repeats
 * per hunk in other clients) and keeps the hunk headers verbatim without any
 * highlight, so a reader can still see where each hunk starts. Reproducing those
 * two rules exactly is what makes the rendered diff recognisable next to the
 * Android client.
 */

/** How one diff line is toned. */
export enum DiffLineTone {
  None = 0,
  Added = 1,
  Deleted = 2,
}

export interface DiffLine {
  text: string;
  tone: DiffLineTone;
}

export interface DiffPreview {
  lines: DiffLine[];
  addedCount: number;
  deletedCount: number;
}

/**
 * Parses a unified diff into toned lines.
 *
 * Dropped: `diff --git `, `index `, `--- ` and `+++ ` lines. Kept verbatim with
 * no tone: `@@` hunk headers. `+` and `-` lines lose their marker and gain a
 * tone; a blank body becomes a single space so the row keeps its height.
 */
export function diffPreview(diff: string): DiffPreview {
  const lines: DiffLine[] = [];
  let added: number = 0;
  let deleted: number = 0;

  for (const rawLine of diff.split('\n')) {
    if (rawLine.startsWith('diff --git ')
      || rawLine.startsWith('index ')
      || rawLine.startsWith('--- ')
      || rawLine.startsWith('+++ ')) {
      continue;
    }
    if (rawLine.startsWith('@@')) {
      lines.push({ text: rawLine, tone: DiffLineTone.None });
      continue;
    }
    if (rawLine.startsWith('+')) {
      added += 1;
      lines.push({ text: trimTrailing(rawLine.substring(1)), tone: DiffLineTone.Added });
      continue;
    }
    if (rawLine.startsWith('-')) {
      deleted += 1;
      lines.push({ text: trimTrailing(rawLine.substring(1)), tone: DiffLineTone.Deleted });
      continue;
    }
    if (rawLine.length === 0) {
      lines.push({ text: ' ', tone: DiffLineTone.None });
      continue;
    }
    // A context line carries a single leading space that is not content.
    const text: string = rawLine.startsWith(' ') ? rawLine.substring(1) : rawLine;
    lines.push({ text: trimTrailing(text), tone: DiffLineTone.None });
  }

  return { lines: lines, addedCount: added, deletedCount: deleted };
}

/** Preview for one file change, using the change's own diff body. */
export function fileChangePreview(change: TimelineFileChange): DiffPreview {
  return diffPreview(change.diff);
}

function trimTrailing(text: string): string {
  let end: number = text.length;
  while (end > 0 && (text.charAt(end - 1) === ' ' || text.charAt(end - 1) === '\t')) {
    end -= 1;
  }
  return text.substring(0, end);
}

/** Tone colours, identical in intent to Android's diff highlight fills. */
export function diffToneBackground(tone: DiffLineTone, isDark: boolean): string {
  if (tone === DiffLineTone.Added) {
    return isDark ? '#163820' : '#DDF8E7';
  }
  if (tone === DiffLineTone.Deleted) {
    return isDark ? '#411C1C' : '#FFE1E1';
  }
  return '#00000000';
}
