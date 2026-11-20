import type { TunnelOffer } from 'meshcall'

import { TUNNEL_AUTHORIZATION } from '../generated/device-meshcall/v1_0/tunnel-authorization.js'

export const DEVICE_CONTROL = TUNNEL_AUTHORIZATION.device_control
const methodsByService = new Map<string, readonly string[]>(Object.entries(DEVICE_CONTROL.scopes))

export function allowsDeviceControl(service: string, method: string): boolean {
  return methodsByService.get(service)?.includes(method) === true
}

export function acceptsDeviceControl(offer: TunnelOffer): boolean {
  return offer.principal === DEVICE_CONTROL.principal && Boolean(offer.e2e_key) &&
    offer.scopes.length > 0 && offer.scopes.every(scope =>
      scope.methods.length > 0 && scope.methods.every(method => allowsDeviceControl(scope.service, method)))
}
