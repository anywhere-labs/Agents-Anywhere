"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import { FolderOpen } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel, FieldGroup } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { FileBrowserDialog } from "@/components/workspace-file-browser-dialog"
import { useAuth } from "@/components/auth/auth-context"
import { dashboardApi } from "@/features/dashboard/api"
import { workspaceName } from "@/features/dashboard/project-workspaces"
import type { DeviceRuntimeView, ProjectCreateRequest, ProjectView, PendingProjectOperation } from "@/features/dashboard/types"

export type ProjectEditorState = { mode: "create"; connectorId?: string; path?: string } | null

export function ProjectEditorDialog({ editor, connectors, preferredConnectorId, onOpenChange, onCreate }: {
  editor: ProjectEditorState
  connectors: Array<{ id: string; name: string; status: string; deviceOs?: string | null }>
  preferredConnectorId?: string
  projects: ProjectView[]
  onOpenChange: (open: boolean) => void
  onCreate: (payload: ProjectCreateRequest) => Promise<ProjectView | null>
}) {
  const t = useTranslations("dashboard.projectSync")
  const { session } = useAuth()
  const [connectorId, setConnectorId] = React.useState("")
  const [runtimes, setRuntimes] = React.useState<DeviceRuntimeView[]>([])
  const [runtimeId, setRuntimeId] = React.useState("")
  const [path, setPath] = React.useState("")
  const [name, setName] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [browserOpen, setBrowserOpen] = React.useState(false)
  const [recoveryRevision, setRecoveryRevision] = React.useState(0)
  const [pending, setPending] = React.useState<PendingProjectOperation[]>([])
  const [recoveryError, setRecoveryError] = React.useState<string | null>(null)
  const receipt = React.useRef({ key: "", requestId: "" })
  const selected = runtimes.find(r => r.runtimeId === runtimeId)
  const device = connectors.find(c => c.id === connectorId)
  React.useEffect(() => {
    if (editor?.mode !== "create") return
    setConnectorId(editor.connectorId || preferredConnectorId || connectors.find(c => c.status === "online")?.id || "")
    setPath(editor.path || ""); setName(editor.path ? workspaceName(editor.path) : "")
    receipt.current = { key: "", requestId: "" }
  }, [editor])
  React.useEffect(() => {
    let cancelled = false
    setRuntimes([]); setRuntimeId("")
    if (!session || !connectorId || !editor) return
    void dashboardApi.getConnectorRuntimes(session.accessToken, connectorId).then(result => {
      if (cancelled) return
      const options = result.runtimes.filter(r => r.configured && r.active)
      setRuntimes(options); setRuntimeId(options[0]?.runtimeId || "")
    }).catch(error => { if (!cancelled) toast.error(String(error)) })
    return () => { cancelled = true }
  }, [connectorId, session?.accessToken, Boolean(editor)])
  React.useEffect(() => {
    let cancelled = false
    setPending([]); setRecoveryError(null)
    if (!editor || !session) return
    void dashboardApi.pendingProjectOperations(session.accessToken).then(result => {
      if (!cancelled) setPending(result.operations)
    }).catch(() => { if (!cancelled) setRecoveryError(t("recoveryFailed")) })
    return () => { cancelled = true }
  }, [Boolean(editor), session?.accessToken, recoveryRevision, t])
  const resume = async (entry: PendingProjectOperation, again = false) => {
    if (saving) return
    setSaving(true)
    try {
      const result = await onCreate({ ...entry.request, newOperation: again || entry.request.newOperation || false,
        requestId: again ? crypto.randomUUID() : entry.request.requestId })
      if (result) { toast.success(t("created")); onOpenChange(false) }
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false); setRecoveryRevision(value => value + 1) }
  }
  const create = async () => {
    if (!selected || saving || !path.trim() || !name.trim()) return
    setSaving(true)
    try {
      const key = JSON.stringify([connectorId, runtimeId, path.trim(), name.trim()])
      if (receipt.current.key !== key) receipt.current = { key, requestId: crypto.randomUUID() }
      const result = await onCreate({ connectorId, runtime: selected.runtimeType, runtimeId,
        workspacePath: path.trim(), name: name.trim(), requestId: receipt.current.requestId })
      if (result) { toast.success(t("created")); onOpenChange(false) }
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false); setRecoveryRevision(value => value + 1) }
  }
  return <>
    <Dialog open={editor?.mode === "create"} onOpenChange={open => { if (!saving) onOpenChange(open) }}>
      <DialogContent className="sm:max-w-lg">
        <form className="flex flex-col gap-6" onSubmit={event => { event.preventDefault(); void create() }}>
          <DialogHeader><DialogTitle>{t("title")}</DialogTitle><DialogDescription>{t("description")}</DialogDescription></DialogHeader>
          {pending.length > 0 ? <div role="region" tabIndex={0} className="flex max-h-48 flex-col gap-3 overflow-y-auto" aria-label={t("pendingOperations")}>
            <p className="text-sm">{t("pendingDescription")}</p>
            {pending.map(entry => <div key={entry.operation.operationId} className="flex flex-col gap-2">
              <p className="text-sm">{entry.request.name} · {entry.operation.project ? t("created") : entry.operation.status === "succeeded" ? t("awaitingSync") : entry.operation.status === "pending" ? t("processing") : t("unconfirmed")}</p>
              <p className="truncate text-xs text-muted-foreground">{entry.request.workspacePath}</p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" disabled={saving} onClick={() => void resume(entry)}>{t("resume")}</Button>
                <Button type="button" variant="ghost" disabled={saving} onClick={() => void resume(entry, true)}>{t("createAgain")}</Button>
              </div>
            </div>)}
          </div> : null}
          {recoveryError ? <p role="status" className="text-sm text-muted-foreground">{recoveryError}</p> : null}
          <FieldGroup>
            <Field><FieldLabel htmlFor="project-device">{t("device")}</FieldLabel>
              <Select value={connectorId} disabled={saving} onValueChange={setConnectorId}>
                <SelectTrigger id="project-device"><SelectValue placeholder={t("selectDevice")} /></SelectTrigger>
                <SelectContent>{connectors.filter(c => c.status === "online").map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field><FieldLabel htmlFor="project-runtime">{t("runtime")}</FieldLabel>
              <Select value={runtimeId} disabled={saving} onValueChange={setRuntimeId}>
                <SelectTrigger id="project-runtime"><SelectValue placeholder={t("selectRuntime")} /></SelectTrigger>
                <SelectContent>{runtimes.map(r => <SelectItem key={r.runtimeId} value={r.runtimeId}>{r.displayName} · {r.runtimeId}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field><FieldLabel htmlFor="project-path">{t("directory")}</FieldLabel><div className="flex gap-2">
              <Input id="project-path" value={path} disabled={saving} onChange={e => { setPath(e.target.value); if (!name) setName(workspaceName(e.target.value)) }} />
              <Button type="button" variant="outline" disabled={saving || !connectorId} aria-label={t("browse")} onClick={() => setBrowserOpen(true)}><FolderOpen /></Button>
            </div></Field>
            <Field><FieldLabel htmlFor="project-name">{t("name")}</FieldLabel><Input id="project-name" maxLength={255} value={name} disabled={saving} onChange={e => setName(e.target.value)} /></Field>
          </FieldGroup>
          {selected && !selected.capabilities?.projectCreate ? <p className="text-sm text-muted-foreground">{(selected.capabilities?.directoryProjects ? t("firstSessionRequired") : t("upgradeRequired"))}</p> : null}
          <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
            <Button type="submit" disabled={saving || !selected?.capabilities?.projectCreate || !name.trim() || !path.trim()}>{saving ? t("creating") : t("create")}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <FileBrowserDialog open={browserOpen} onOpenChange={setBrowserOpen} connectorId={connectorId} connectorDeviceOs={device?.deviceOs}
      token={session?.accessToken} initialPath={path || "~"} onConfirm={next => { setPath(next); if (!name) setName(workspaceName(next)) }} />
  </>
}
