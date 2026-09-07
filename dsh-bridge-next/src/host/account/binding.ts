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
  /** Retains the registration key when a confirmed replacement response is lost. */
  replacesConnectorId?: string
  name: string
}

export type BoundDevice = Binding & { connectorId: string; connectorToken: string }
export class DeviceRecoveryRequired extends Error {
  constructor(readonly connectorId: string, readonly reason: 'deleted' | 'disconnected') {
    super(reason === 'deleted' ? '本机设备已被删除，是否重新创建？' : '本机设备已断开连接，是否重新连接？')
  }
}

function bindingPath(root: string, account: Account): string {
  const key = createHash('sha256').update(`${account.apiBaseUrl}\n${account.userId}`).digest('hex')
  return join(root, 'bindings', `${key}.json`)
}

/** Loading an identity for display never renews credentials or contacts the server. */
export async function readBoundDevice(root: string, account: Account): Promise<BoundDevice | null> {
  const binding = await readJson<Binding>(bindingPath(root, account))
  return binding?.connectorId && binding.connectorToken ? binding as BoundDevice : null
}

/** Process maintenance stays on the existing device, independent of the shared discovery order. */
export async function verifyBoundDevice(binding: BoundDevice, account: Account, api: AccountApi, signal: AbortSignal): Promise<BoundDevice> {
  let device
  try { device = await api.device(account.accessToken, binding.connectorId, signal) }
  catch (error) {
    if (error instanceof ApiError && error.status === 404) throw new DeviceRecoveryRequired(binding.connectorId, 'deleted')
    throw error
  }
  signal.throwIfAborted()
  if (device.userId !== account.userId) throw new Error('设备归属与当前账号不一致。')
  if (!await api.verifyConnector(binding.connectorId, binding.connectorToken, signal)) {
    throw new DeviceRecoveryRequired(binding.connectorId, 'disconnected')
  }
  return { ...binding, name: device.name }
}

export async function ensureBinding(root: string, account: Account, api: AccountApi, signal: AbortSignal, options: {
  machineState?: LocalMachineRegistry
  renew?: boolean
} = {}): Promise<BoundDevice> {
  const path = bindingPath(root, account)
  let binding = await readJson<Binding>(path)
  const machine = options.machineState ?? localMachineRegistry()
  const localIds = await machine.readConnectorIds()
  // Older plugin installations already have a private binding. Keep it as the
  // last local candidate; Desktop's ordered shared IDs always take precedence.
  const candidates = [...new Set([...localIds, ...(binding?.connectorId ? [binding.connectorId] : [])])]
  const devices = await api.devices(account.accessToken, signal)
  signal.throwIfAborted()
  const owned = new Map(devices.filter(device => device.userId === account.userId).map(device => [device.id, device]))
  // A saved device must never be silently replaced or have revoked credentials
  // renewed on startup/OAuth. Only the recovery button authorizes those actions.
  if (binding?.replacesConnectorId) throw new DeviceRecoveryRequired(binding.replacesConnectorId, 'deleted')
  if (binding?.connectorId && !owned.has(binding.connectorId)) throw new DeviceRecoveryRequired(binding.connectorId, 'deleted')
  let verified = false
  if (binding?.connectorId) {
    verified = Boolean(binding.connectorToken && await api.verifyConnector(binding.connectorId, binding.connectorToken, signal))
    if (!verified) throw new DeviceRecoveryRequired(binding.connectorId, 'disconnected')
  }
  const matchedId = candidates.find(id => owned.has(id))
  if (matchedId) {
    const device = owned.get(matchedId)!
    const cached = binding?.connectorId === matchedId ? binding : null
    const connectorToken = !options.renew && cached?.connectorToken && verified
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
  binding ??= { installationId: randomUUID(), name: await systemDeviceName() }
  return registerBinding(path, binding, account, api, signal, machine)
}

/** Explicit recovery always targets this binding, never another shared Desktop ID. */
export async function recoverBinding(root: string, account: Account, api: AccountApi, signal: AbortSignal,
  id: string, action: 'reconnect' | 'recreate', machine = localMachineRegistry()): Promise<BoundDevice> {
  const path = bindingPath(root, account)
  const binding = await readJson<Binding>(path)
  if (!binding || (binding.connectorId !== id && binding.replacesConnectorId !== id)) throw new Error('本机设备记录已变化，请重新打开插件。')
  let device
  try { device = await api.device(account.accessToken, id, signal) }
  catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error }
  signal.throwIfAborted()
  if (device && device.userId !== account.userId) throw new Error('设备归属与当前账号不一致。')
  if (action === 'reconnect') {
    if (!device) throw new DeviceRecoveryRequired(id, 'deleted')
    let connectorToken: string
    try { connectorToken = await api.renewConnector(account.accessToken, id, signal) }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) throw new DeviceRecoveryRequired(id, 'deleted')
      throw error
    }
    const complete = { installationId: binding.installationId, name: device.name, connectorId: id, connectorToken }
    await writeJson(path, complete)
    await machine.recordConnectorId(id)
    signal.throwIfAborted()
    return complete
  }
  if (device) throw new DeviceRecoveryRequired(id, 'disconnected')
  const pending = binding.replacesConnectorId === id ? binding
    : { installationId: randomUUID(), name: await systemDeviceName(), replacesConnectorId: id }
  return registerBinding(path, pending, account, api, signal, machine)
}

async function registerBinding(path: string, binding: Binding, account: Account, api: AccountApi,
  signal: AbortSignal, machine: LocalMachineRegistry): Promise<BoundDevice> {
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
    binding = { ...binding, installationId: randomUUID() }
    await writeJson(path, binding)
    signal.throwIfAborted()
    created = await api.register(account.accessToken, binding.name, binding.installationId, signal)
  }
  if (created.connector.userId !== account.userId) throw new Error('注册设备的账号不一致。')
  const complete = { installationId: binding.installationId, name: binding.name, connectorId: created.connector.id, connectorToken: created.connectorToken }
  await writeJson(path, complete)
  // Do not report pairing success before Desktop can discover the new identity.
  // Keep the private binding on failure so retry never registers another device.
  await machine.recordConnectorId(complete.connectorId)
  return complete
}
