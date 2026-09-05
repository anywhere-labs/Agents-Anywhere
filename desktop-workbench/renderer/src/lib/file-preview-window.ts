export type PickedFile = {
  name: string
  path: string
  sourceUrl?: string
  mediaType?: string
  size?: number
}

export function nativeFilePreviewUrl({
  connectorId,
  root,
  file,
}: {
  connectorId?: string | null
  root: string
  file: PickedFile
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
  return `/#/preview?${search.toString()}`
}

export function openNativeFilePreviewWindow({
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
  const child = window.open(
    nativeFilePreviewUrl({ connectorId, root, file }),
    "_blank",
    "width=980,height=720,resizable=yes,scrollbars=yes",
  )
  if (!child) {
    onBlocked?.()
    return
  }
  child.focus()
}
