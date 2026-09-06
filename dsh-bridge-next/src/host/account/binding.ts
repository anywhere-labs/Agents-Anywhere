import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { AccountApi, ApiError, type Account } from './api.js'
import { readJson, writeJson } from '../storage/files.js'

export interface Binding {
  installationId: string
  connectorId?: string
  connectorToken?: string
  name: string
}

export async function ensureBinding(root: string, account: Account, api: AccountApi, signal: AbortSignal): Promise<Required<Binding>> {
  const key = createHash('sha256').update(`${account.apiBaseUrl}\n${account.userId}`).digest('hex')
  const path = join(root, 'bindings', `${key}.json`)
  let binding = await readJson<Binding>(path)
  if (binding?.connectorId && binding.connectorToken) {
    try {
      const device = await api.device(account.accessToken, binding.connectorId, signal)
      if (device.userId !== account.userId) throw new Error('设备不属于当前账号，请重新配对。')
      if (!await api.verifyConnector(binding.connectorId, binding.connectorToken, signal)) {
        binding.connectorToken = await api.renewConnector(account.accessToken, binding.connectorId, signal)
        await writeJson(path, binding)
      }
      return binding as Required<Binding>
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error
      binding = null
    }
  }
  binding ??= { installationId: randomUUID(), name: `${hostname() || '本机设备'} · DSH` }
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
  return complete
}
