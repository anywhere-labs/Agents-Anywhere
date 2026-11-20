// Desktop uses the active owner’s local client-admin endpoint, including when CLI or DSH owns the device.
import { ownerAlive, readRuntimeState, requestClientGrants, requestMobilePairing, requestClientPairingStatus, routerDirectory, runtimeRecordPath } from '../../connector-ts/src/host/index.js'
import type { AuthorizedClients, ClientGrantSelection, ClientPairingResult } from '../shared/client-pairing.js'

export async function startClientPairing(home: string): Promise<ClientPairingResult> {
  const owner = (await readRuntimeState(runtimeRecordPath(home))).runtime
  if (!owner || !(await ownerAlive(owner))) return { ok: false, code: 'connector_not_running' }
  try {
    const { uri, pairingId, fingerprint, expiresAt } = await requestMobilePairing(
      { ...owner, connectorVersion: owner.connectorVersion ?? null }, routerDirectory(home),
    )
    return { ok: true, uri, pairingId, fingerprint, expiresAt }
  } catch (error) {
    const code = (error as { code?: unknown })?.code
    switch (code) {
      case 'connector_not_running':
      case 'connector_offline':
      case 'e2ee_off':
      case 'pairing_limit':
        return { ok: false, code }
      default:
        return { ok: false, code: 'not_available' }
    }
  }
}

async function localOwner(home: string) {
  const owner = (await readRuntimeState(runtimeRecordPath(home))).runtime
  if (!owner || !(await ownerAlive(owner))) throw new Error('connector_not_running')
  return { ...owner, connectorVersion: owner.connectorVersion ?? null }
}

export async function clientPairingStatus(home: string, pairingId: string) {
  return requestClientPairingStatus(await localOwner(home), routerDirectory(home), pairingId)
}

export async function getClientGrants(home: string, target?: ClientGrantSelection): Promise<AuthorizedClients> {
  const view = await requestClientGrants(await localOwner(home), routerDirectory(home), target)
  return {
    deviceId: view.deviceId,
    clients: view.grants.filter(grant => !grant.revokedAt).map(({ clientId, label, identityPubFingerprint, grantedAt }) =>
      ({ clientId, label, identityPubFingerprint, grantedAt })),
  }
}
