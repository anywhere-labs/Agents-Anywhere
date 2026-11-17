import { createReadStream } from 'node:fs'

import { MeshCallError } from 'meshcall'

import type { ControlPlane } from './control-plane.js'
import type { Egress } from './egress.js'
import { HttpError, requestBytes, uploadStream } from './http.js'

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

/** Where a `Store/readBlob` call wants the bytes (the Server's one-time relay transfer). */
export interface BlobTransfer {
  readonly transferId: string
  readonly token: string
  /** `/api/v3/device/transfers/{transferId}`; resolved against the Server URL, never another origin. */
  readonly path: string
}

/** A local file to send: read from disk as it is uploaded. */
export interface UploadFile {
  readonly path: string
  readonly size: number
  readonly mediaType: string
}

export type TransferUpload = (transfer: BlobTransfer, file: UploadFile, signal?: AbortSignal) => Promise<void>

/**
 * Streams a local file to a `Store/readBlob` relay (`PUT /api/v3/device/transfers/{transferId}`) with the device's
 * access token and the transfer token, over the Connector's egress. A 401 refreshes the token once and sends the
 * file again from the start; a 410 (the reader went away) ends the call as cancelled.
 */
export function deviceTransferUploader(serverUrl: string, handshake: Pick<ControlPlane, 'accessToken' | 'invalidate'>, egress: () => Egress, timeoutMs = 60_000): TransferUpload {
  const base = new URL(serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`)
  return async (transfer, file, signal) => {
    // Relative to the Server URL so a path-prefixed deployment keeps its prefix; the token never leaves the origin.
    const url = new URL(transfer.path.replace(/^\/+/u, ''), base)
    if (url.origin !== base.origin) throw new MeshCallError('invalid_argument', 'the transfer path points at another origin')
    const put = async () => uploadStream(egress, {
      url,
      headers: { authorization: `Bearer ${await handshake.accessToken(signal)}`, 'x-transfer-token': transfer.token },
      body: () => createReadStream(file.path),
      size: file.size,
      contentType: file.mediaType,
      timeoutMs,
      ...(signal !== undefined ? { signal } : {}),
    })
    try {
      try {
        await put()
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 401) throw error
        handshake.invalidate()
        await put()
      }
    } catch (error) {
      if (error instanceof HttpError && error.status === 410) throw new MeshCallError('cancelled', 'the reader went away')
      throw error
    }
  }
}
