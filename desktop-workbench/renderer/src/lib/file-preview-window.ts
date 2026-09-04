export type PickedFile = {
  name: string
  path: string
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
  const search = new URLSearchParams({
    connectorId: connectorId ?? "",
    root,
    path: file.path,
    name: file.name,
  })
  const child = window.open(`/#/preview?${search.toString()}`, "_blank", "width=980,height=720,resizable=yes,scrollbars=yes")
  if (!child) {
    onBlocked?.()
    return
  }
  child.focus()
}
