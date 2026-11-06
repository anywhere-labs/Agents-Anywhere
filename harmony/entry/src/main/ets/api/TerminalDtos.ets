import { numberOr, optionalNumber, requireString, stringOr } from './ApiJson';

/**
 * Remote terminal payloads.
 *
 * Port of `api/TerminalDtos.kt`.
 *
 * Every field is read the way Android's `optString`/`optInt`/`optLong` pair
 * reads it, including the one transformation that is easy to miss: a blank
 * `label` falls back to `zsh` rather than to an empty string.
 */
export class RemoteTerminal {
  terminalId: string = '';
  sessionId: string = '';
  label: string = '';
  cwd: string = '';
  cols: number = 80;
  rows: number = 24;
  purpose: string = 'user';
  pid: number | null = null;
  status: string = 'starting';
  exitCode: number | null = null;
  scrollbackBytes: number = 0;
  scrollbackSeq: number = 0;
}

/** The wire shape; every field is optional because the Server may omit any. */
export interface RemoteTerminalDto {
  terminalId?: string;
  sessionId?: string;
  label?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  purpose?: string;
  pid?: number | null;
  status?: string;
  exitCode?: number | null;
  scrollbackBytes?: number;
  scrollbackSeq?: number;
}

/** Android's `JSONObject.toRemoteTerminal`. */
export function parseRemoteTerminal(dto: RemoteTerminalDto): RemoteTerminal {
  const terminal: RemoteTerminal = new RemoteTerminal();
  terminal.terminalId = requireString(dto.terminalId, 'terminalId');
  terminal.sessionId = stringOr(dto.sessionId, '');
  terminal.label = labelOrDefault(dto.label);
  terminal.cwd = stringOr(dto.cwd, '');
  terminal.cols = numberOr(dto.cols, 80);
  terminal.rows = numberOr(dto.rows, 24);
  terminal.purpose = stringOr(dto.purpose, 'user');
  terminal.pid = optionalNumber(dto.pid ?? undefined);
  terminal.status = stringOr(dto.status, 'starting');
  terminal.exitCode = optionalNumber(dto.exitCode ?? undefined);
  terminal.scrollbackBytes = numberOr(dto.scrollbackBytes, 0);
  terminal.scrollbackSeq = numberOr(dto.scrollbackSeq, 0);
  return terminal;
}

/**
 * The label with Android's `ifBlank` applied.
 *
 * `optString("label", "zsh").ifBlank { "zsh" }` is stricter than the shared
 * blank helper: Kotlin's `isBlank()` counts whitespace, so a label of spaces is
 * replaced while any other label is kept verbatim.
 */
function labelOrDefault(value: string | undefined): string {
  const raw: string = stringOr(value, '');
  return raw.trim().length === 0 ? 'zsh' : raw;
}
