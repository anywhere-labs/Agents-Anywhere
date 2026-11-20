// Returned only to the local renderer that requested an invitation.
export type ClientPairingResult =
  | { ok: true; uri: string; fingerprint: string; expiresAt: string }
  | { ok: false; code: "connector_not_running" | "connector_offline" | "e2ee_off" | "pairing_limit" | "not_available" };
