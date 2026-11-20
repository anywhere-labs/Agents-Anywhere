// Returned only to the local renderer that requested an invitation.
export type ClientPairingResult =
  | { ok: true; pairingId: string; uri: string; fingerprint: string; expiresAt: string }
  | { ok: false; code: "connector_not_running" | "connector_offline" | "e2ee_off" | "pairing_limit" | "not_available" };

export type ClientPairingStatus = { status: 'pending' | 'paired' | 'invalid' };

export interface AuthorizedClient {
  clientId: string;
  label: string;
  identityPubFingerprint: string;
  grantedAt: string;
}

export interface AuthorizedClients {
  deviceId: string;
  clients: AuthorizedClient[];
}

export type ClientGrantSelection = Pick<AuthorizedClients, "deviceId"> & Pick<AuthorizedClient, "clientId" | "grantedAt">;
