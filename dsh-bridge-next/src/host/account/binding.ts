import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { AccountApi, ApiError, type Account } from './api.js'
import { systemDeviceName } from './device-name.js'
import { readJson, writeJson } from '../storage/files.js'
import { localMachineRegistry, type LocalMachineRegistry } from '../desktop/machine-state.js'

export interface Binding {
  installationId: string
  connectorId?: string
  connectorToken?: string
  name: string
}

export async function ensureBinding(root: string, account: Account, api: AccountApi, signal: AbortSignal, options: {
  machineState?: LocalMachineRegistry
  renew?: boolean
} = {}): Promise<Required<Binding>> {
  const key = createHash('sha256').update(`${account.apiBaseUrl}\n${account.userId}`).digest('hex')
  const path = join(root, 'bindings', `${key}.json`)
  let binding = await readJson<Binding>(path)
  const machine = options.machineState ?? localMachineRegistry()
  const localIds = await machine.readConnectorIds()
  // Older plugin installations already have a private binding. Keep it as the
  // last local candidate; Desktop's ordered shared IDs always take precedence.
  const candidates = [...new Set([...localIds, ...(binding?.connectorId ? [binding.connectorId] : [])])]
  const devices = await api.devices(account.accessToken, signal)
  signal.throwIfAborted()
  const owned = new Map(devices.filter(device => device.userId === account.userId).map(device => [device.id, device]))
  const matchedId = candidates.find(id => owned.has(id))
  if (matchedId) {
    const device = owned.get(matchedId)!
    const cached = binding?.connectorId === matchedId ? binding : null
    const connectorToken = !options.renew && cached?.connectorToken && await api.verifyConnector(matchedId, cached.connectorToken, signal)
      ? cached.connectorToken : await api.renewConnector(account.accessToken, matchedId, signal)
    signal.throwIfAborted()
    const complete = {
      installationId: cached?.installationId ?? randomUUID(), name: device.name,
      connectorId: matchedId, connectorToken,
    }
    await writeJson(path, complete)
    // Backfill older private bindings only after server ownership and credentials
    // are verified. A failed publish can retry with this persisted credential.
    await machine.recordConnectorId(complete.connectorId)
    return complete
  }
  // A deleted or other-account ID is never revived. Pending registration keys
  // without an ID still recover a lost POST response idempotently.
  if (binding?.connectorId) binding = null
  binding ??= { installationId: randomUUID(), name: await systemDeviceName() }
  // Persist the registration key before the request: even a lost response can
  // be recovered without creating a second device on the server.
  await writeJson(path, binding)
  signal.throwIfAborted()
  let created: Awaited<ReturnType<AccountApi['register']>>
  try {
    created = await api.register(account.accessToken, binding.name, binding.installationId, signal)
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error
    // The response to an earlier registration was lost, and that device was
    // deleted before we recovered it. Never revive a deleted installation.
    binding = { installationId: randomUUID(), name: binding.name }
    await writeJson(path, binding)
    signal.throwIfAborted()
    created = await api.register(account.accessToken, binding.name, binding.installationId, signal)
  }
  if (created.connector.userId !== account.userId) throw new Error('注册设备的账号不一致。')
  const complete = { ...binding, connectorId: created.connector.id, connectorToken: created.connectorToken }
  await writeJson(path, complete)
  // Do not report pairing success before Desktop can discover the new identity.
  // Keep the private binding on failure so retry never registers another device.
  await machine.recordConnectorId(complete.connectorId)
  return complete
}
