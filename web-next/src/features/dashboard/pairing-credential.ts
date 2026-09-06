import { dashboardApi } from "@/features/dashboard/api"
import type { ConnectorCreateResponse, ConnectorRevokeResponse } from "@/features/dashboard/types"

export type PairingCredential = ConnectorCreateResponse | ConnectorRevokeResponse

/** Keep one device when users go back to edit its name or reuse a rotated token. */
export async function preparePairingCredential(
  accessToken: string,
  name: string,
  credential: PairingCredential | null,
): Promise<PairingCredential> {
  const trimmedName = name.trim()
  if (!trimmedName) throw new Error("Device name is required")
  if (!credential) return dashboardApi.createConnector(accessToken, trimmedName)
  if (credential.connector.name === trimmedName) return credential

  const result = await dashboardApi.updateConnector(accessToken, credential.connector.id, {
    name: trimmedName,
  })
  return { ...credential, connector: result.connector }
}
