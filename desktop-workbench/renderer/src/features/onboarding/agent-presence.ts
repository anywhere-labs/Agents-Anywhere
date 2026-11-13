import { dashboardApi } from '@/features/dashboard/api'

/** Persisted configuration counts even when the device or Agent is offline. */
export async function hasConfiguredAgents(token: string): Promise<boolean> {
  const { connectors } = await dashboardApi.listConnectors(token)
  const inventories = await Promise.allSettled(connectors.map(connector =>
    dashboardApi.getConnectorRuntimes(token, connector.id)))
  if (inventories.some(result => result.status === 'fulfilled' && result.value.runtimes.some(runtime => runtime.configured))) return true
  const failed = inventories.find(result => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  return false
}
