import { homedir } from 'node:os'
import { localRuntimePath, readMachineStateFile } from './local-runtime.js'

export const machineStatePath = localRuntimePath

export interface LocalMachineRegistry {
  readConnectorIds(): Promise<string[]>
}

export function localMachineRegistry(home = homedir()): LocalMachineRegistry {
  return { readConnectorIds: () => readLocalConnectorIds(home) }
}

export async function readMachineState(home = homedir()): Promise<Record<string, unknown>> {
  return readMachineStateFile(machineStatePath(home))
}

export async function readLocalConnectorIds(home = homedir()): Promise<string[]> {
  return readMachineStateFile(machineStatePath(home)).connectorIds
}
