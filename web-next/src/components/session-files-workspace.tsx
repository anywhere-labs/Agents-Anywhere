"use client"

import * as React from "react"
import { FilesPanelBody } from "@/components/panels/files-panel"
import { FilePreviewSurface } from "@/components/file-preview-page"
import type { SessionToolTab } from "@/components/session-tool-tabs"
import type { OpenSessionFilePreview } from "@/components/session/session-file-preview-context"
import { openNativeFilePreviewWindow } from "@/lib/file-preview-window"

type Props = {
  tabs: SessionToolTab[]
  activeTabId: string
  token: string | null
  connectorId: string | null
  connectorDeviceOs?: string | null
  root: string
  onDirtyChange: (id: string, dirty: boolean) => void
  onOpenFilePreview: OpenSessionFilePreview
  onPinTab: (id: string) => void
}

// One directory browser and split layout per workspace; documents remain mounted
// independently so changing tabs does not discard edits or editor view state.
export function SessionFilesWorkspace(props: Props) {
  const { tabs, activeTabId, token, connectorId, connectorDeviceOs, onDirtyChange, onOpenFilePreview, onPinTab } = props
  const lastActiveId = React.useRef(activeTabId)
  const activeTab = tabs.find(tab => tab.id === activeTabId)
  if (activeTab) lastActiveId.current = activeTab.id
  const tab = activeTab ?? tabs.find(tab => tab.id === lastActiveId.current) ?? tabs[0]!
  const file = tab.filePreview
  const openFile: OpenSessionFilePreview = React.useCallback((file, options) => {
    onOpenFilePreview(file, { ...options, sourceTabId: tab.id })
  }, [onOpenFilePreview, tab.id])
  const pin = React.useCallback(() => onPinTab(tab.id), [onPinTab, tab.id])
  return (
    <FilesPanelBody
      token={token} connectorId={connectorId} connectorDeviceOs={connectorDeviceOs}
      root={file?.root ?? props.root} variant="tab" initialFile={file}
      onOpenFilePreview={openFile} onKeepFileOpen={pin}
      previewContent={
        <div className="relative h-full min-h-0" data-slot="session-file-documents">
          {tabs.filter(document => document.filePreview).map(document => (
            <FileDocument key={document.id} tab={document} active={document.id === tab.id}
              token={token} connectorId={connectorId} onDirtyChange={onDirtyChange} />
          ))}
        </div>
      }
    />
  )
}

const FileDocument = React.memo(function FileDocument({ tab, active, token, connectorId, onDirtyChange }: {
  tab: SessionToolTab
  active: boolean
  token: string | null
  connectorId: string | null
  onDirtyChange: Props["onDirtyChange"]
}) {
  const file = tab.filePreview!
  const dirty = React.useCallback((value: boolean) => onDirtyChange(tab.id, value), [onDirtyChange, tab.id])
  return (
    <div className={`absolute inset-0 ${active ? "" : "invisible pointer-events-none"}`}
      aria-hidden={!active} inert={!active || undefined} data-file-tab-id={tab.id}>
      <FilePreviewSurface token={token ?? ""} connectorId={connectorId ?? ""} root={file.root}
        initialPath={file.path} initialName={file.name} mode="embedded" onDirtyChange={dirty}
        onOpenExternal={() => openNativeFilePreviewWindow({ token, connectorId, root: file.root, file })} />
    </div>
  )
})
