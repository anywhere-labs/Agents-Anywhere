/**
 * Single-device filesystem, git, and attachment operations for the v3
 * Connector (`aa.v3.Device` business service, wired in Wave 2).
 *
 * Every operation is bounded (byte caps, entry caps, timeouts), never goes
 * through a shell, and reports failures as `DeviceOpsError` with a stable
 * `code` the RPC layer can forward verbatim.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { atomicWriteFile, DEFAULT_MAX_RPC_FILE_BYTES } from "./state-store.js";

/** `DevicePlatform` in control.schema.json. */
export type DevicePlatform = "macos" | "linux" | "windows";

export type DeviceOpsErrorCode =
  | "invalid_argument"
  | "invalid_path"
  | "not_found"
  | "permission_denied"
  | "not_a_directory"
  | "is_a_directory"
  | "not_a_regular_file"
  | "file_too_large_for_rpc"
  | "attachment_too_large"
  | "invalid_encoding"
  | "git_unavailable"
  | "git_failed";

export class DeviceOpsError extends Error {
  readonly code: DeviceOpsErrorCode;

  constructor(code: DeviceOpsErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "DeviceOpsError";
    this.code = code;
  }
}

export const DEFAULT_GIT_DIFF_MAX_BYTES = 512 * 1024;
export const DEFAULT_LIST_DIRS_MAX_ENTRIES = 5000;
const GIT_TIMEOUT_MS = 15_000;
const GIT_STATUS_MAX_BYTES = 32 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function devicePlatform(platform: NodeJS.Platform = process.platform): DevicePlatform {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

/**
 * Resolve a client-supplied path. `~` and `~/…` expand to the home directory;
 * relative paths resolve against `baseDir` (default: home), because the
 * Connector daemon's own working directory is meaningless to a remote client.
 */
export function resolveUserPath(input: string, baseDir: string = os.homedir()): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new DeviceOpsError("invalid_path", "path must be a non-empty string");
  }
  if (input.includes("\0")) {
    throw new DeviceOpsError("invalid_path", "path must not contain NUL bytes");
  }
  let expanded = input;
  if (expanded === "~") expanded = os.homedir();
  else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  return path.resolve(baseDir, expanded);
}

function mapFsError(err: unknown, target: string): DeviceOpsError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "ENOENT":
      return new DeviceOpsError("not_found", `no such file or directory: ${target}`, { cause: err });
    case "EACCES":
    case "EPERM":
      return new DeviceOpsError("permission_denied", `permission denied: ${target}`, { cause: err });
    case "ENOTDIR":
      return new DeviceOpsError("not_a_directory", `not a directory: ${target}`, { cause: err });
    case "EISDIR":
      return new DeviceOpsError("is_a_directory", `is a directory: ${target}`, { cause: err });
    default:
      return new DeviceOpsError("invalid_path", `${code ?? "error"}: ${target}`, { cause: err });
  }
}

function requireNonNegativeInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DeviceOpsError("invalid_argument", `${name} must be a non-negative integer`);
  }
  return value;
}

function requirePositiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new DeviceOpsError("invalid_argument", `${name} must be a positive integer`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Device status
// ---------------------------------------------------------------------------

export interface DeviceStatus {
  platform: DevicePlatform;
  hostname: string;
  cwd: string;
  arch: string;
  node_version: string;
  connector_version: string;
  /** Seconds since the Connector process (or `startedAt`) started. */
  uptime_seconds: number;
}

export interface DeviceStatusOptions {
  connectorVersion: string;
  /** Working directory to report; defaults to the home directory. */
  cwd?: string;
  /** Connector start time (ms since epoch); defaults to process start. */
  startedAt?: number;
}

export function getDeviceStatus(opts: DeviceStatusOptions): DeviceStatus {
  const uptime =
    opts.startedAt === undefined ? process.uptime() : Math.max(0, (Date.now() - opts.startedAt) / 1000);
  return {
    platform: devicePlatform(),
    hostname: os.hostname(),
    cwd: opts.cwd ?? os.homedir(),
    arch: process.arch,
    node_version: process.version,
    connector_version: opts.connectorVersion,
    uptime_seconds: Math.floor(uptime),
  };
}

// ---------------------------------------------------------------------------
// Directory listing
// ---------------------------------------------------------------------------

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  /** ISO timestamp; null when the entry could not be stat'ed (e.g. broken link, EACCES). */
  mtime: string | null;
}

export interface ListDirsResult {
  path: string;
  parent: string | null;
  entries: DirEntry[];
  /** True when the directory held more than `maxEntries` entries. */
  truncated: boolean;
}

export interface ListDirsOptions {
  maxEntries?: number;
}

export async function listDirs(dirPath?: string, opts: ListDirsOptions = {}): Promise<ListDirsResult> {
  const target = dirPath === undefined ? os.homedir() : resolveUserPath(dirPath);
  const maxEntries = requirePositiveInt(opts.maxEntries ?? DEFAULT_LIST_DIRS_MAX_ENTRIES, "maxEntries");

  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch (err) {
    throw mapFsError(err, target);
  }

  // Sort by name before truncating so repeated calls return a stable prefix.
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const truncated = dirents.length > maxEntries;
  const selected = truncated ? dirents.slice(0, maxEntries) : dirents;

  const entries: DirEntry[] = [];
  const BATCH = 64;
  for (let i = 0; i < selected.length; i += BATCH) {
    const batch = selected.slice(i, i + BATCH);
    entries.push(...(await Promise.all(batch.map((dirent) => describeEntry(target, dirent)))));
  }
  entries.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const parent = path.dirname(target);
  return { path: target, parent: parent === target ? null : parent, entries, truncated };
}

async function describeEntry(dir: string, dirent: Dirent): Promise<DirEntry> {
  const full = path.join(dir, dirent.name);
  const isSymlink = dirent.isSymbolicLink();
  let stat: Stats | undefined;
  try {
    // Follow symlinks so a link to a directory is navigable.
    stat = await fs.stat(full);
  } catch {
    stat = undefined;
  }
  return {
    name: dirent.name,
    path: full,
    is_dir: stat ? stat.isDirectory() : dirent.isDirectory(),
    is_symlink: isSymlink,
    size: stat && stat.isFile() ? stat.size : 0,
    mtime: stat ? stat.mtime.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// File read / write
// ---------------------------------------------------------------------------

export interface ReadFileOptions {
  /** Start of a bounded slice. Requesting a slice bypasses the whole-file cap check. */
  offsetBytes?: number;
  /** Length of a bounded slice (clamped to `maxRpcFileBytes`). */
  maxBytes?: number;
  /** Per-RPC payload cap; default 8 MiB (settings.max_rpc_file_bytes). */
  maxRpcFileBytes?: number;
}

export interface ReadFileResult {
  path: string;
  /** Total file size in bytes. */
  size: number;
  offset: number;
  bytes_read: number;
  /** True when the returned slice reaches the end of the file. */
  eof: boolean;
  /** `utf8` when the bytes are valid UTF-8 text without NULs, otherwise `base64`. */
  encoding: "utf8" | "base64";
  content: string;
  mtime: string;
}

export async function readFile(filePath: string, opts: ReadFileOptions = {}): Promise<ReadFileResult> {
  const target = resolveUserPath(filePath);
  const cap = requirePositiveInt(opts.maxRpcFileBytes ?? DEFAULT_MAX_RPC_FILE_BYTES, "maxRpcFileBytes");
  const offset = requireNonNegativeInt(opts.offsetBytes ?? 0, "offsetBytes");
  const sliceRequested = opts.offsetBytes !== undefined || opts.maxBytes !== undefined;
  const requested = opts.maxBytes === undefined ? cap : requireNonNegativeInt(opts.maxBytes, "maxBytes");

  let stat: Stats;
  try {
    stat = await fs.stat(target);
  } catch (err) {
    throw mapFsError(err, target);
  }
  if (stat.isDirectory()) throw new DeviceOpsError("is_a_directory", `is a directory: ${target}`);
  // Refuse FIFOs, sockets and devices: opening a FIFO blocks forever and
  // /dev/zero never ends.
  if (!stat.isFile()) throw new DeviceOpsError("not_a_regular_file", `not a regular file: ${target}`);
  if (!sliceRequested && stat.size > cap) {
    throw new DeviceOpsError(
      "file_too_large_for_rpc",
      `file is ${stat.size} bytes, over the ${cap}-byte RPC cap; request a slice with offsetBytes/maxBytes`,
    );
  }

  const length = Math.max(0, Math.min(requested, cap, stat.size - offset));
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  if (length > 0) {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(target, "r");
    } catch (err) {
      throw mapFsError(err, target);
    }
    try {
      // Positioned reads bounded by `length`: a file that grows after stat
      // can never push the payload past the cap.
      while (bytesRead < length) {
        const { bytesRead: n } = await handle.read(buffer, bytesRead, length - bytesRead, offset + bytesRead);
        if (n === 0) break;
        bytesRead += n;
      }
    } finally {
      await handle.close();
    }
  }
  const bytes = buffer.subarray(0, bytesRead);
  const text = decodeUtf8Text(bytes);
  return {
    path: target,
    size: stat.size,
    offset,
    bytes_read: bytesRead,
    eof: offset + bytesRead >= stat.size,
    encoding: text === null ? "base64" : "utf8",
    content: text ?? bytes.toString("base64"),
    mtime: stat.mtime.toISOString(),
  };
}

function decodeUtf8Text(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

export interface WriteFileResult {
  path: string;
  size: number;
  mtime: string;
}

export async function writeFile(
  filePath: string,
  content: string,
  encoding: "utf8" | "base64" = "utf8",
  maxBytes: number = DEFAULT_MAX_RPC_FILE_BYTES,
): Promise<WriteFileResult> {
  const requested = resolveUserPath(filePath);
  const cap = requirePositiveInt(maxBytes, "maxBytes");
  if (typeof content !== "string") throw new DeviceOpsError("invalid_argument", "content must be a string");
  if (encoding !== "utf8" && encoding !== "base64") {
    throw new DeviceOpsError("invalid_encoding", 'encoding must be "utf8" or "base64"');
  }
  const data = encoding === "utf8" ? Buffer.from(content, "utf8") : decodeBase64Bounded(content, cap, "file_too_large_for_rpc");
  if (data.byteLength > cap) {
    throw new DeviceOpsError("file_too_large_for_rpc", `content is ${data.byteLength} bytes, over the ${cap}-byte cap`);
  }

  // Write through symlinks (as editors do) instead of replacing the link.
  let target = requested;
  let existingMode: number | undefined;
  try {
    target = await fs.realpath(requested);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) throw new DeviceOpsError("is_a_directory", `is a directory: ${requested}`);
    if (!stat.isFile()) throw new DeviceOpsError("not_a_regular_file", `not a regular file: ${requested}`);
    // Keep rwx bits only: a remote write must never carry setuid/setgid/sticky over.
    existingMode = stat.mode & 0o777;
  } catch (err) {
    if (err instanceof DeviceOpsError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw mapFsError(err, requested);
    target = requested;
  }

  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await atomicWriteFile(
      target,
      data,
      existingMode === undefined ? {} : { mode: existingMode, exactMode: true },
    );
    const stat = await fs.stat(target);
    return { path: target, size: stat.size, mtime: stat.mtime.toISOString() };
  } catch (err) {
    throw mapFsError(err, target);
  }
}

/**
 * Validate and decode standard base64, rejecting oversize payloads from the
 * encoded length *before* allocating the decoded buffer.
 */
function decodeBase64Bounded(input: string, maxBytes: number, tooLarge: DeviceOpsErrorCode): Buffer {
  const compact = input.replace(/\s+/g, "");
  if (compact.length % 4 === 1 || !BASE64_RE.test(compact)) {
    throw new DeviceOpsError("invalid_encoding", "content is not valid base64");
  }
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  const estimated = Math.floor((compact.length * 3) / 4) - padding;
  if (estimated > maxBytes) {
    throw new DeviceOpsError(tooLarge, `decoded payload is ${estimated} bytes, over the ${maxBytes}-byte cap`);
  }
  return Buffer.from(compact, "base64");
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export interface GitStatusEntry {
  path: string;
  /** Source path for renames / copies. */
  orig_path?: string;
  /** Porcelain v1 X (index) and Y (worktree) columns. */
  index: string;
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export type GitStatusResult =
  | { is_repo: false }
  | {
      is_repo: true;
      branch: string | null;
      upstream: string | null;
      ahead: number;
      behind: number;
      detached: boolean;
      clean: boolean;
      entries: GitStatusEntry[];
      staged: string[];
      modified: string[];
      untracked: string[];
      conflicted: string[];
    };

export type GitDiffResult =
  | { is_repo: false }
  | { is_repo: true; diff: string; truncated: boolean; bytes: number };

export interface GitDiffOptions {
  filePath?: string;
  staged?: boolean;
  maxBytes?: number;
}

/**
 * Flags that neutralize repository-controlled program execution. A repo's
 * `.git/config` may set `core.fsmonitor` (run on every `git status`) or diff
 * drivers / textconv commands; the device must not run them just because a
 * client browsed that directory.
 */
const GIT_SAFE_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-c", "color.ui=false"];

interface GitRun {
  code: number;
  stdout: Buffer;
  stderr: string;
  truncated: boolean;
}

function runGit(cwd: string, args: readonly string[], maxBytes: number): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...GIT_SAFE_CONFIG, ...args],
      {
        cwd,
        encoding: "buffer",
        // +1 so "exactly maxBytes" is distinguishable from "more than maxBytes".
        maxBuffer: maxBytes + 1,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
          LC_ALL: "C",
        },
      },
      (error, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
        const errText = (Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "")).toString("utf8");
        if (!error) {
          resolve({ code: 0, stdout: out, stderr: errText, truncated: false });
          return;
        }
        const err = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean };
        if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({ code: 0, stdout: out, stderr: errText, truncated: true });
          return;
        }
        if (err.code === "ENOENT") {
          reject(new DeviceOpsError("git_unavailable", "git executable not found on PATH", { cause: error }));
          return;
        }
        if (err.killed) {
          reject(new DeviceOpsError("git_failed", `git ${args[0] ?? ""} timed out`, { cause: error }));
          return;
        }
        resolve({ code: typeof err.code === "number" ? err.code : 1, stdout: out, stderr: errText, truncated: false });
      },
    );
  });
}

async function requireDirectory(cwd: string): Promise<string> {
  const target = resolveUserPath(cwd);
  let stat: Stats;
  try {
    stat = await fs.stat(target);
  } catch (err) {
    throw mapFsError(err, target);
  }
  if (!stat.isDirectory()) throw new DeviceOpsError("not_a_directory", `not a directory: ${target}`);
  return target;
}

function isNotRepo(run: GitRun): boolean {
  return run.code !== 0 && /not a git repository/i.test(run.stderr);
}

function gitFailure(run: GitRun, what: string): DeviceOpsError {
  const detail = run.stderr.trim().split("\n").slice(0, 3).join(" ").slice(0, 500);
  return new DeviceOpsError("git_failed", `${what} exited with ${run.code}${detail ? `: ${detail}` : ""}`);
}

export async function gitStatus(cwd: string): Promise<GitStatusResult> {
  const dir = await requireDirectory(cwd);
  const run = await runGit(dir, ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=normal"], GIT_STATUS_MAX_BYTES);
  if (isNotRepo(run)) return { is_repo: false };
  if (run.code !== 0) throw gitFailure(run, "git status");
  if (run.truncated) throw new DeviceOpsError("git_failed", "git status output exceeded the size cap");
  return parsePorcelainV1(run.stdout.toString("utf8"));
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/** Parse `git status --porcelain=v1 -b -z` output. Exported for unit tests. */
export function parsePorcelainV1(output: string): Extract<GitStatusResult, { is_repo: true }> {
  const records = output.split("\0");
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let detached = false;
  const entries: GitStatusEntry[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record === undefined || record.length === 0) continue;
    if (record.startsWith("## ")) {
      ({ branch, upstream, ahead, behind, detached } = parseBranchLine(record.slice(3)));
      continue;
    }
    if (record.length < 4) continue;
    const index = record.charAt(0);
    const worktree = record.charAt(1);
    const entryPath = record.slice(3);
    const entry: GitStatusEntry = {
      path: entryPath,
      index,
      worktree,
      staged: false,
      unstaged: false,
      untracked: false,
      conflicted: false,
    };
    if (index === "R" || index === "C") {
      // With -z, the source path of a rename/copy follows as its own record.
      const orig = records[i + 1];
      if (orig !== undefined) {
        entry.orig_path = orig;
        i++;
      }
    }
    const xy = index + worktree;
    if (xy === "??") entry.untracked = true;
    else if (CONFLICT_CODES.has(xy)) entry.conflicted = true;
    else {
      entry.staged = index !== " " && index !== "!";
      entry.unstaged = worktree !== " " && worktree !== "!";
    }
    if (xy !== "!!") entries.push(entry);
  }

  const pick = (pred: (e: GitStatusEntry) => boolean) => entries.filter(pred).map((e) => e.path);
  return {
    is_repo: true,
    branch,
    upstream,
    ahead,
    behind,
    detached,
    clean: entries.length === 0,
    entries,
    staged: pick((e) => e.staged),
    modified: pick((e) => e.unstaged),
    untracked: pick((e) => e.untracked),
    conflicted: pick((e) => e.conflicted),
  };
}

function parseBranchLine(line: string): {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
} {
  let rest = line;
  let ahead = 0;
  let behind = 0;
  const tracking = / \[([^\]]*)\]$/.exec(rest);
  if (tracking) {
    rest = rest.slice(0, tracking.index);
    const info = tracking[1] ?? "";
    ahead = Number(/ahead (\d+)/.exec(info)?.[1] ?? 0);
    behind = Number(/behind (\d+)/.exec(info)?.[1] ?? 0);
  }
  if (rest.startsWith("HEAD (no branch)")) {
    return { branch: null, upstream: null, ahead, behind, detached: true };
  }
  const unborn = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(rest);
  if (unborn) return { branch: unborn[1] ?? null, upstream: null, ahead, behind, detached: false };
  // Ref names cannot contain "..", so splitting on "..." is unambiguous.
  const sep = rest.indexOf("...");
  if (sep >= 0) {
    return { branch: rest.slice(0, sep), upstream: rest.slice(sep + 3), ahead, behind, detached: false };
  }
  return { branch: rest.length > 0 ? rest : null, upstream: null, ahead, behind, detached: false };
}

export async function gitDiff(cwd: string, opts: GitDiffOptions = {}): Promise<GitDiffResult> {
  const dir = await requireDirectory(cwd);
  const maxBytes = requirePositiveInt(opts.maxBytes ?? DEFAULT_GIT_DIFF_MAX_BYTES, "maxBytes");
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
  if (opts.staged) args.push("--cached");
  if (opts.filePath !== undefined) {
    if (typeof opts.filePath !== "string" || opts.filePath.length === 0 || opts.filePath.includes("\0")) {
      throw new DeviceOpsError("invalid_path", "filePath must be a non-empty string without NUL bytes");
    }
    // `--` ends option parsing, so a path like "--output=/etc/x" stays a path.
    args.push("--", opts.filePath);
  }
  const run = await runGit(dir, args, maxBytes);
  if (isNotRepo(run)) return { is_repo: false };
  if (run.code !== 0 && !run.truncated) throw gitFailure(run, "git diff");

  let out = run.stdout;
  let truncated = run.truncated || out.byteLength > maxBytes;
  if (truncated) {
    out = out.subarray(0, maxBytes);
    // Cut at the last complete line so the client never renders half a hunk line
    // or a split multi-byte character.
    const lastNewline = out.lastIndexOf(0x0a);
    if (lastNewline >= 0) out = out.subarray(0, lastNewline + 1);
    truncated = true;
  }
  return { is_repo: true, diff: out.toString("utf8"), truncated, bytes: out.byteLength };
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export interface SaveAttachmentRequest {
  name: string;
  base64: string;
  mime?: string;
  maxBytes?: number;
}

export interface SavedAttachment {
  id: string;
  path: string;
  name: string;
  mime: string;
  size: number;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
};

/** Reduce a client-supplied file name to a safe single path component. */
export function sanitizeFileName(name: string): string {
  const base = (typeof name === "string" ? name : "").split(/[\\/]/).pop() ?? "";
  let safe = base
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .replace(/_{2,}/g, "_");
  // Keep the name within common filesystem limits (255 bytes) with room for the id prefix.
  while (Buffer.byteLength(safe, "utf8") > 120) safe = safe.slice(0, -1);
  return safe.length > 0 ? safe : "attachment";
}

export async function saveAttachment(dataDir: string, req: SaveAttachmentRequest): Promise<SavedAttachment> {
  if (typeof req.base64 !== "string") throw new DeviceOpsError("invalid_argument", "base64 must be a string");
  const maxBytes = requirePositiveInt(req.maxBytes ?? DEFAULT_MAX_RPC_FILE_BYTES, "maxBytes");
  const data = decodeBase64Bounded(req.base64, maxBytes, "attachment_too_large");
  if (data.byteLength > maxBytes) {
    throw new DeviceOpsError("attachment_too_large", `attachment is ${data.byteLength} bytes, over the ${maxBytes}-byte cap`);
  }
  const name = sanitizeFileName(req.name);
  const mime =
    typeof req.mime === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(req.mime) && req.mime.length <= 128
      ? req.mime
      : (MIME_BY_EXT[path.extname(name).toLowerCase()] ?? "application/octet-stream");
  const id = `${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
  const dir = path.join(path.resolve(dataDir), "attachments");
  const target = path.join(dir, `${id}-${name}`);
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await atomicWriteFile(target, data, { mode: 0o600, exactMode: true });
  } catch (err) {
    throw mapFsError(err, target);
  }
  return { id, path: target, name, mime, size: data.byteLength };
}
