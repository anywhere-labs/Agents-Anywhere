import { randomUUID } from 'node:crypto'
import { copyFile, link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { acquireManagerLock, hasCode, readJson, writeJson } from './files.js'

const receipt = '.legacy-state-migrated.json'

/** Caller holds the destination manager lease until the manager stops. */
export async function migrateStateRoot(target: string, source?: string): Promise<void> {
  if (!source) return
  const migrated = await readJson<{ version: number }>(join(target, receipt))
  if (migrated !== null) {
    if (migrated.version !== 1) throw new Error('数据目录迁移记录版本无效。')
    return
  }
  let sourceExists = true
  try { await lstat(source) } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
    sourceExists = false
  }
  if (sourceExists) {
    // Also exclude a still-running plugin using the old default directory.
    const release = await acquireManagerLock(join(source, 'manager.lock'))
    try { await copyMissing(source, target, source, target) }
    finally { await release() }
  }
  // Retaining this small receipt prevents logout/reset from resurrecting old data.
  await writeJson(join(target, receipt), { version: 1 })
}

async function copyMissing(source: string, target: string, oldRoot: string, newRoot: string): Promise<void> {
  const entry = await lstat(source)
  let existing: Awaited<ReturnType<typeof lstat>> | undefined
  try { existing = await lstat(target) } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
  if (entry.isDirectory()) {
    if (existing && !existing.isDirectory()) throw new Error(`迁移目录冲突：${target}`)
    await mkdir(target, { recursive: true, mode: 0o700 })
    for (const name of await readdir(source)) {
      // Virtual environments contain absolute paths; uv recreates them at the new root.
      if (source === oldRoot && ['connector-venv', 'manager.lock', receipt].includes(name)) continue
      await copyMissing(join(source, name), join(target, name), oldRoot, newRoot)
    }
    return
  }
  if (existing) {
    if (!existing.isFile() || !entry.isFile()) throw new Error(`迁移文件冲突：${target}`)
    return // The new directory is authoritative, including newer checkpoints.
  }
  if (!entry.isFile()) throw new Error(`无法迁移非普通文件：${source}`)
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    if (relative(oldRoot, source) === join('connector', 'connector.json')) {
      const config = await readJson<Record<string, unknown>>(source)
      if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('旧 Connector 配置格式无效。')
      for (const key of ['statePath', 'attachmentsRoot']) {
        const value = config[key]
        if (typeof value !== 'string' || !isAbsolute(value)) continue
        const suffix = relative(oldRoot, value)
        if (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)) config[key] = join(newRoot, suffix)
      }
      await writeJson(temporary, config)
    } else {
      await copyFile(source, temporary)
      const file = await open(temporary, 'r+')
      try { await file.chmod(0o600); await file.sync() } finally { await file.close() }
    }
    // Publish only complete files; never replace a concurrently created target.
    try { await link(temporary, target) } catch (error) { if (!hasCode(error, 'EEXIST')) throw error }
  } finally { await rm(temporary, { force: true }) }
}
