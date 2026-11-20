// Use the same restricted local role as anywhere-cli pair-client, including when CLI or DSH owns the device.
import { ownerAlive, readRuntimeState, requestClientPairing, routerDirectory, runtimeRecordPath } from '../../connector-ts/src/host/index.js'
import type { ClientPairingResult } from '../shared/client-pairing.js'

export async function startClientPairing(home: string): Promise<ClientPairingResult> {
  const owner = (await readRuntimeState(runtimeRecordPath(home))).runtime
  if (!owner || !(await ownerAlive(owner))) return { ok: false, code: 'connector_not_running' }
  try {
    const { uri, fingerprint, expiresAt } = await requestClientPairing(
      { ...owner, connectorVersion: owner.connectorVersion ?? null }, routerDirectory(home),
    )
    return { ok: true, uri, fingerprint, expiresAt }
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
