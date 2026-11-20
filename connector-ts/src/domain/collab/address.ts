/** Where a session lives: the only way collaboration names a session (session ids are unique per account). */
export interface SessionAddress {
  readonly deviceId: string
  readonly sessionId: string
}

export function sameAddress(a: SessionAddress, b: SessionAddress): boolean {
  return a.deviceId === b.deviceId && a.sessionId === b.sessionId
}

export function addressKey(address: SessionAddress): string {
  return `${address.deviceId}/${address.sessionId}`
}
