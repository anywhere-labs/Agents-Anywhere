import type { ControlPlane } from './control-plane.js'
import type { Egress } from './egress.js'
import { HttpError, requestBytes } from './http.js'

/**
 * Downloads a file a client uploaded for a session on this device (`GET /api/v3/device/attachments/{fileId}?sessionId=`,
 * C's #707) with the device's access token over the Connector's egress. A 401 refreshes the token once.
 */
export function deviceAttachmentFetcher(serverUrl: string, handshake: Pick<ControlPlane, 'accessToken' | 'invalidate'>, egress: () => Egress): (fileId: string, sessionId: string, signal?: AbortSignal) => Promise<AsyncIterable<Uint8Array>> {
  const base = serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`
  return async (fileId, sessionId, signal) => {
    const url = new URL(`api/v3/device/attachments/${encodeURIComponent(fileId)}`, base)
    url.searchParams.set('sessionId', sessionId)
    const get = async () => requestBytes(egress, { url, headers: { authorization: `Bearer ${await handshake.accessToken(signal)}` }, ...(signal !== undefined ? { signal } : {}) })
    let response
    try {
      response = await get()
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 401) throw error
      handshake.invalidate()
      response = await get()
    }
    const body = response.body
    return (async function* () {
      yield body
    })()
  }
}
