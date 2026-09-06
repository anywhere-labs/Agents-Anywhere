import { userInfo } from 'node:os'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hasCode } from '../storage/files.js'

export const machineStatePath = (home = userInfo().homedir): string => join(home, '.agentsanywhere', 'machine.json')

/** Desktop owns this public record. Keep account and Connector tokens in private storage. */
export async function readMachineState(home = userInfo().homedir): Promise<Record<string, unknown> | null> {
  let value: unknown
  try { value = JSON.parse(await readFile(machineStatePath(home), 'utf8')) }
  catch (error) {
    if (hasCode(error, 'ENOENT')) return null
    throw new Error('无法读取本机共享记录，请打开桌面端修复后重试。')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('version' in value) || value.version !== 1) {
    throw new Error('本机共享记录无效，请打开桌面端修复后重试。')
  }
  return value as Record<string, unknown>
}

export async function readLocalConnectorIds(home = userInfo().homedir): Promise<string[]> {
  const state = await readMachineState(home)
  if (!state || state['connectorIds'] === undefined) return []
  const ids = state['connectorIds']
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error('本机设备记录无效，请打开桌面端修复后重试。')
  }
  return [...new Set((ids as string[]).map(id => id.trim()))]
}
