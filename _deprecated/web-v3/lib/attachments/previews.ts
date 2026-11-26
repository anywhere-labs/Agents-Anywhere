"use client"

// Image previews for attachments (client-experience-proposal §3.3): an image sent from this browser shows its local
// thumbnail at once (by device path); otherwise the bytes are read from the device (`read_file`, ≤ the RPC cap) once
// and kept as an object URL, keyed by device + path (+ mtime once known).

import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import type { DeviceRecord } from "@/lib/types/v3"

type TunnelDevice = Pick<DeviceRecord, "id" | "mode_hint" | "presence">

const sentPreviews = new Map<string, string>()

/** Keep a sent image's local object URL for its device path (never revoked: the sent message shows it). */
export function rememberPreview(path: string, url: string) {
  sentPreviews.set(path, url)
}

export function sentPreview(path: string): string | undefined {
  return sentPreviews.get(path)
}

const IMAGE_READ_MAX = 8 * 1024 * 1024
const deviceImages = new Map<string, Promise<string | null>>()

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** An image on the device as an object URL (null when it cannot be read: too large, gone, offline). */
export function loadDeviceImage(
  manager: DeviceTunnelManager,
  device: TunnelDevice,
  path: string,
  mime: string
): Promise<string | null> {
  const local = sentPreviews.get(path)
  if (local) return Promise.resolve(local)
  const key = `${device.id}:${path}`
  const hit = deviceImages.get(key)
  if (hit) return hit
  const task = (async () => {
    try {
      const res = await manager.readFile(device, path, { maxBytes: IMAGE_READ_MAX })
      if (!res.eof) return null
      const bytes = res.encoding === "base64" ? base64ToBytes(res.content) : new TextEncoder().encode(res.content)
      return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime || "application/octet-stream" }))
    } catch {
      deviceImages.delete(key)
      return null
    }
  })()
  deviceImages.set(key, task)
  return task
}
