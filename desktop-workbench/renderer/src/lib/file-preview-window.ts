export type PickedFile = {
  name: string
  path: string
  sourceUrl?: string
  mediaType?: string
  size?: number
}

export const PREVIEW_AUTH_REQUEST = "aa:preview-auth-request"
export const PREVIEW_AUTH_RESPONSE = "aa:preview-auth-response"

export function nativeFilePreviewUrl({
  connectorId,
  root,
  file,
  previewRequestId,
}: {
  connectorId?: string | null
  root: string
  file: PickedFile
  previewRequestId?: string
}) {
  const search = new URLSearchParams({
    connectorId: connectorId ?? "",
    root,
    path: file.path,
    name: file.name,
  })
  if (file.sourceUrl) search.set("sourceUrl", file.sourceUrl)
  if (file.mediaType) search.set("mediaType", file.mediaType)
  if (typeof file.size === "number") search.set("size", String(file.size))
  if (previewRequestId) search.set("previewRequestId", previewRequestId)
  return `/#/preview?${search.toString()}`
}

export function openNativeFilePreviewWindow({
  token,
  connectorId,
  root,
  file,
  onBlocked,
}: {
  token?: string | null
  connectorId?: string | null
  root: string
  file: PickedFile
  onBlocked?: () => void
}) {
  const previewRequestId = token ? crypto.randomUUID() : undefined
  const child = window.open(
    nativeFilePreviewUrl({ connectorId, root, file, previewRequestId }),
    "_blank",
    "width=980,height=720,resizable=yes,scrollbars=yes",
  )
  if (!child) {
    onBlocked?.()
    return
  }
  if (token && previewRequestId) {
    const origin = window.location.origin
    const onMessage = (event: MessageEvent) => {
      if (event.source !== child || event.origin !== origin) return
      const data = event.data
      if (data?.type !== PREVIEW_AUTH_REQUEST || data.previewRequestId !== previewRequestId) return
      child.postMessage({ type: PREVIEW_AUTH_RESPONSE, previewRequestId, token }, origin)
    }
    const cleanup = () => {
      window.removeEventListener("message", onMessage)
      window.clearInterval(closeCheck)
      window.removeEventListener("pagehide", cleanup)
    }
    window.addEventListener("message", onMessage)
    window.addEventListener("pagehide", cleanup)
    const closeCheck = window.setInterval(() => { if (child.closed) cleanup() }, 5_000)
  }
  child.focus()
}

export function requestNativeFilePreviewToken(previewRequestId: string, onToken: (token: string) => void): () => void {
  const opener = window.opener
  if (!previewRequestId || !opener) return () => {}
  const origin = window.location.origin
  const onMessage = (event: MessageEvent) => {
    if (event.source !== opener || event.origin !== origin) return
    const data = event.data
    if (data?.type !== PREVIEW_AUTH_RESPONSE || data.previewRequestId !== previewRequestId || typeof data.token !== "string") return
    onToken(data.token)
  }
  window.addEventListener("message", onMessage)
  opener.postMessage({ type: PREVIEW_AUTH_REQUEST, previewRequestId }, origin)
  return () => window.removeEventListener("message", onMessage)
}
