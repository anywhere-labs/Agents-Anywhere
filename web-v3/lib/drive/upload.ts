// Uploading a file into a drive folder from the drive page: the same presigned flow as large attachments
// (lib/attachments/transfer.ts): POST /drive/uploads → PUT straight to storage with progress → /complete.
// The file keeps its own name in the folder; a taken name gets a " (1)" suffix from the server.

import { completeDriveUpload, createDriveUpload, deleteDriveFile } from "@/lib/api/control-http"
import { putWithProgress, sha256HexOf, TransferError } from "@/lib/attachments/transfer"
import type { DriveFileView } from "@/lib/types/v3"

export interface DriveUploadOptions {
  serverUrl: string
  getToken: () => Promise<string>
  /** Folder the file goes into, e.g. "/报告/2026". */
  folder: string
  onProgress?: (sent: number, total: number) => void
  signal?: AbortSignal
}

export async function uploadToDrive(file: File, opts: DriveUploadOptions): Promise<DriveFileView> {
  const { serverUrl, getToken, folder, onProgress, signal } = opts
  const check = () => {
    if (signal?.aborted) throw new TransferError("aborted", "Upload cancelled")
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  check()
  const sha256 = await sha256HexOf(bytes)
  check()
  const token = await getToken()
  const created = await createDriveUpload(serverUrl, token, {
    purpose: "transfer",
    size_bytes: bytes.byteLength,
    sha256,
    filename: file.name,
    mime_type: file.type || "application/octet-stream",
    folder,
    on_conflict: "rename",
  })
  try {
    onProgress?.(0, bytes.byteLength)
    const put = await putWithProgress(created.upload, bytes, (sent) => onProgress?.(sent, bytes.byteLength), signal)
    check()
    return await completeDriveUpload(serverUrl, await getToken(), created.file.id, put.etag)
  } catch (err) {
    // The reservation would otherwise hold quota until it expires.
    void getToken()
      .then((tok) => deleteDriveFile(serverUrl, tok, created.file.id))
      .catch(() => undefined)
    throw err
  }
}
