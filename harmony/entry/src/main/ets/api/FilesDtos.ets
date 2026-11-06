import { arrayField, booleanOr, numberOr, optionalString, stringOrFallbackWhenBlank } from './ApiJson';

/**
 * Remote file DTOs.
 *
 * Port of `api/FilesDtos.kt` plus the parsing in `api/FilesApi.kt`.
 *
 * The Server answers `/fs/list` with `{ "result": … }` and `/fs/readText` with the
 * file object directly, which is why only the directory read unwraps an envelope.
 */

export interface RemoteDirectoryEntryDto {
  name?: string;
  path?: string;
  type?: string;
  size?: number | null;
}

export interface RemoteDirectoryEntry {
  name: string;
  path: string;
  /** `directory`, `file` or anything else, which the controller filters out. */
  type: string;
  size: number | null;
}

export interface RemoteDirectoryDto {
  path?: string;
  entries?: RemoteDirectoryEntryDto[];
  truncated?: boolean;
  targetType?: string;
}

export interface RemoteDirectory {
  path: string;
  entries: RemoteDirectoryEntry[];
  truncated: boolean;
  targetType: string;
}

export interface RemoteTextFileDto {
  path?: string;
  name?: string;
  size?: number;
  sha256?: string;
  encoding?: string;
  content?: string;
  truncated?: boolean;
  binary?: boolean;
  serverTime?: string;
}

export interface RemoteTextFile {
  path: string;
  name: string;
  size: number;
  sha256: string;
  encoding: string;
  content: string;
  truncated: boolean;
  binary: boolean;
  serverTime: string;
}

export function parseRemoteDirectoryEntry(dto: RemoteDirectoryEntryDto): RemoteDirectoryEntry {
  const size: number | null = dto.size === undefined || dto.size === null
    ? null
    : numberOr(dto.size, 0);
  return {
    name: stringOrFallbackWhenBlank(dto.name, 'Untitled'),
    path: dto.path ?? '',
    type: stringOrFallbackWhenBlank(dto.type, 'other'),
    size: size,
  };
}

export function parseRemoteDirectory(dto: RemoteDirectoryDto, fallbackPath: string): RemoteDirectory {
  const entries: RemoteDirectoryEntry[] = [];
  for (const entry of arrayField(dto.entries)) {
    entries.push(parseRemoteDirectoryEntry(entry as RemoteDirectoryEntryDto));
  }
  return {
    path: stringOrFallbackWhenBlank(dto.path, fallbackPath),
    entries: entries,
    truncated: booleanOr(dto.truncated, false),
    targetType: stringOrFallbackWhenBlank(dto.targetType, 'directory'),
  };
}

export function parseRemoteTextFile(dto: RemoteTextFileDto): RemoteTextFile {
  return {
    path: dto.path ?? '',
    name: stringOrFallbackWhenBlank(dto.name, 'Untitled'),
    size: numberOr(dto.size, 0),
    sha256: dto.sha256 ?? '',
    encoding: stringOrFallbackWhenBlank(dto.encoding, 'utf8'),
    content: dto.content ?? '',
    truncated: booleanOr(dto.truncated, false),
    binary: booleanOr(dto.binary, false),
    serverTime: optionalString(dto.serverTime) ?? '',
  };
}
