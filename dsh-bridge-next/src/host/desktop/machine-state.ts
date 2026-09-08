import { userInfo } from 'node:os'
import { localRuntimePath, readMachineStateFile } from './local-runtime.js'

export const machineStatePath = localRuntimePath

export interface LocalMachineRegistry {
  readConnectorIds(): Promise<string[]>
}

export function localMachineRegistry(home = userInfo().homedir): LocalMachineRegistry {
  return { readConnectorIds: () => readLocalConnectorIds(home) }
}

export async function readMachineState(home = userInfo().homedir): Promise<Record<string, unknown>> {
  return readMachineStateFile(machineStatePath(home))
}

export async function readLocalConnectorIds(home = userInfo().homedir): Promise<string[]> {
  return readMachineStateFile(machineStatePath(home)).connectorIds
}
