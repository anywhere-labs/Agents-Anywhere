// Reading a device file through an encrypted channel (contracts/e2ee/1.0 「帧与消息」): there is no download URL,
// so the file comes back as `TunnelFileChunk`s of at most 8 MiB, read in order until `eof`.

import type { TunnelFileChunk } from "@/generated/e2ee/v1_0/tunnel-file-chunk"
import type { SessionContentTransport } from "./content-transport"

export type { TunnelFileChunk }

/** `FILE_CHUNK_MAX_BYTES`: the largest slice one read asks for. */
export const FILE_CHUNK_MAX_BYTES = 8 * 1024 * 1024

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * `GET {readPath}?root&path&offset&length` until `eof`. `readPath` is the namespaced
 * `/connectors/{deviceId}/fs/read`; `root` is the workspace root, as in normal mode.
 */
export async function readFileThroughChannel(
  transport: SessionContentTransport,
  readPath: string,
  file: { root: string; path: string },
  options: { chunkBytes?: number; signal?: AbortSignal } = {},
): Promise<{ bytes: Uint8Array<ArrayBuffer>[]; size: number }> {
  const length = Math.min(options.chunkBytes ?? FILE_CHUNK_MAX_BYTES, FILE_CHUNK_MAX_BYTES)
  const parts: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  for (;;) {
    options.signal?.throwIfAborted()
    const chunk = (await transport.request({
      method: "GET",
      path: readPath,
      query: { root: file.root, path: file.path, offset: String(offset), length: String(length) },
    })) as TunnelFileChunk
    if (!chunk || (chunk.encoding ?? "base64") !== "base64" || typeof chunk.data !== "string" || chunk.offset !== offset)
      throw new Error("The device sent an unexpected file chunk.")
    const bytes = fromBase64(chunk.data)
    parts.push(bytes)
    offset += bytes.length
    if (chunk.eof) {
      if (offset !== chunk.size) throw new Error("The device sent a file of the wrong size.")
      return { bytes: parts, size: offset }
    }
    if (bytes.length === 0 || offset > chunk.size) throw new Error("The device stopped sending the file.")
  }
}
