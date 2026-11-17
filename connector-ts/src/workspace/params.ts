// Helpers that read and validate workspace request parameters.
import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

import { invalid } from './errors.js'
import { expandHome } from './roots.js'

export type Params = Readonly<Record<string, unknown>>

export const MAX_DIR_ENTRIES = 500
export const MAX_OUTPUT_CHARS = 64_000
export const MAX_READ_TEXT_BYTES = 4 * 1024 * 1024
export const DEFAULT_READ_TEXT_BYTES = 1024 * 1024

/** `root` (or `cwd`): the session's working directory relative paths are resolved against. */
export function workspaceRoot(params: Params): string {
  const raw = params.root ?? params.cwd
  if (typeof raw !== 'string' || raw.trim() === '') throw invalid('root is required')
  return resolve(expandHome(raw))
}

export function resolvePath(root: string, raw: string): string {
  if (raw.includes('\0')) throw invalid('paths must not contain NUL characters')
  const path = expandHome(raw)
  return isAbsolute(path) ? resolve(path) : resolve(root, path)
}

export function requiredString(params: Params, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value === '') throw invalid(`${key} is required`)
  return value
}

export function requiredText(params: Params, key: string): string {
  const value = params[key]
  if (typeof value !== 'string') throw invalid(`${key} is required`)
  return value
}

export function requiredInt(params: Params, key: string): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) throw invalid(`${key} is required`)
  return value
}

export function checkEncoding(params: Params): void {
  const value = params.encoding ?? 'utf8'
  if (value !== 'utf8' && value !== 'utf-8') throw invalid('only utf8 encoding is supported')
}

async function isDir(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() === true
}

/**
 * `path` if it is a directory, else its closest existing parent, else the same for `fallback`. Session paths can
 * point at projects that were moved or deleted; panels should still open somewhere useful.
 */
export async function nearestExistingDir(path: string, fallback?: string): Promise<string> {
  for (const start of fallback === undefined ? [path] : [path, fallback]) {
    let current = start
    for (;;) {
      if (await isDir(current)) return current
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return process.cwd()
}

/** At most `MAX_OUTPUT_CHARS` characters of a command's output. */
export function decodeOutput(output: Buffer): { text: string; truncated: boolean } {
  const text = output.toString('utf8')
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_OUTPUT_CHARS), truncated: true }
}
