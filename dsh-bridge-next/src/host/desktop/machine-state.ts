import { userInfo } from 'node:os'
import { localRuntimePath, updateLocalState } from './local-runtime.js'

export const machineStatePath = localRuntimePath

export interface LocalMachineRegistry {
  readConnectorIds(): Promise<string[]>
  recordConnectorId(id: string): Promise<void>
}

export function localMachineRegistry(home = userInfo().homedir): LocalMachineRegistry {
  return { readConnectorIds: () => readLocalConnectorIds(home), recordConnectorId: id => recordLocalConnectorId(id, home) }
}

export async function readMachineState(home = userInfo().homedir): Promise<Record<string, unknown>> {
  return updateLocalState(machineStatePath(home), state => ({ ...state }))
}

export async function readLocalConnectorIds(home = userInfo().homedir): Promise<string[]> {
  return updateLocalState(machineStatePath(home), state => [...state.connectorIds])
}

export async function recordLocalConnectorId(id: string, home = userInfo().homedir): Promise<void> {
  const connectorId = id.trim()
  if (!connectorId) throw new Error('本机设备 ID 无效。')
  await updateLocalState(machineStatePath(home), state => {
    if (!state.connectorIds.includes(connectorId)) state.connectorIds.push(connectorId)
  })
}
