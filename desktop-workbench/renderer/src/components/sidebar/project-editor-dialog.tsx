"use client"

import * as React from "react"
import { FolderOpen } from "lucide-react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { FileBrowserDialog } from "@/components/workspace-file-browser-dialog"
import { useAuth } from "@/components/auth/auth-context"
import { dashboardApi } from "@/features/dashboard/api"
import { availableProjectName, findWorkspaceProject, workspaceName } from "@/features/dashboard/project-workspaces"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import type {
  ProjectCreateRequest,
  ProjectPatchRequest,
  ProjectView,
} from "@/features/dashboard/types"
import { isApiError } from "@/lib/api/errors"
import { useTranslations } from "next-intl"

export type ProjectEditorState =
  | { mode: "create" }
  | { mode: "edit"; project: ProjectView }
  | null

export function ProjectEditorDialog({
  editor,
  connectors,
  projects,
  preferredConnectorId,
  onOpenChange,
  onCreate,
  onUpdate,
}: {
  editor: ProjectEditorState
  connectors: Array<{
    id: string
    name: string
    status: string
    deviceOs?: string | null
  }>
  preferredConnectorId?: string
  projects: ProjectView[]
  onOpenChange: (open: boolean) => void
  onCreate: (payload: ProjectCreateRequest) => Promise<ProjectView | null>
  onUpdate: (projectId: string, payload: ProjectPatchRequest) => Promise<ProjectView | null>
}) {
  const t = useTranslations("dashboard.projects")
  const tCommon = useTranslations("common")
  const tWorkspace = useTranslations("dashboard.workspacePicker")
  const { session } = useAuth()
  const [name, setName] = React.useState("")
  const [connectorId, setConnectorId] = React.useState("")
  const [path, setPath] = React.useState("")
  const [browserOpen, setBrowserOpen] = React.useState(false)
  const [nameEdited, setNameEdited] = React.useState(false)
  const [nameAdjusted, setNameAdjusted] = React.useState(false)
  const savingRef = React.useRef(false)
  const [saving, setSaving] = React.useState(false)
  const [nameError, setNameError] = React.useState("")
  const [workspaceConflict, setWorkspaceConflict] = React.useState<ProjectView | null>(null)
  const editingProject = editor?.mode === "edit" ? editor.project : null
  const onlineConnectors = connectors.filter((connector) => connector.status === "online")
  const selectedConnector = connectors.find((connector) => connector.id === connectorId)

  React.useEffect(() => {
    if (!editor) {
      setWorkspaceConflict(null)
      return
    }
    if (editor.mode === "edit") {
      setName(editor.project.name)
      setConnectorId(editor.project.connectorId)
      setPath(editor.project.workspacePath)
    } else {
      setName("")
      setConnectorId(onlineConnectors.find((connector) => connector.id === preferredConnectorId)?.id ?? onlineConnectors[0]?.id ?? "")
      setPath("")
    }
    setSaving(false)
    savingRef.current = false
    setBrowserOpen(false)
    setNameEdited(false)
    setNameAdjusted(false)
    setNameError("")
    setWorkspaceConflict(null)
  }, [editor])

  const existingWorkspace = findWorkspaceProject(projects, connectorId, path, selectedConnector?.deviceOs)
  const ignoredProjectId = editingProject?.id ?? existingWorkspace?.id

  React.useEffect(() => {
    if (!editor || editingProject || nameEdited) return
    const base = existingWorkspace?.name ?? (path.trim() ? workspaceName(path) : "")
    setName(base ? availableProjectName(base, projects, ignoredProjectId) : "")
  }, [editor, editingProject, existingWorkspace?.name, ignoredProjectId, nameEdited, path, projects])

  const normalizeName = () => {
    const next = availableProjectName(name, projects, ignoredProjectId)
    if (name.trim() && next !== name.trim()) {
      setName(next)
      setNameEdited(true)
      setNameAdjusted(true)
    }
    return name.trim() ? next : ""
  }

  const persistProject = async () => {
    if (!editor || !name.trim() || savingRef.current) return
    if (!editingProject && (!path.trim() || selectedConnector?.status !== "online")) return
    const projectName = normalizeName()
    savingRef.current = true
    setSaving(true)
    try {
      let workspacePath = path.trim()
      if (!editingProject && workspacePath.startsWith("~")) {
        const response = await dashboardApi.connectorFsList(session!.accessToken, connectorId, { root: workspacePath, path: "." })
        if (!response.result.path || response.result.targetType === "file") throw new Error(tWorkspace("directoryRequired"))
        workspacePath = response.result.path
        setPath(workspacePath)
      }
      const result = editingProject
        ? await onUpdate(editingProject.id, { name: projectName })
        : await onCreate({ name: projectName, connectorId, workspacePath })
      if (!result) {
        toast.error(t(editingProject ? "updateFailed" : "createFailed"))
        return
      }
      toast.success(t(editingProject ? "updateSuccess" : "createSuccess"))
      onOpenChange(false)
    } catch (error) {
      if (isApiError(error) && error.code === "project_name_conflict") {
        const latest = await dashboardApi.listProjects(session!.accessToken).catch(() => null)
        const next = availableProjectName(projectName, [...(latest?.projects ?? projects), { id: "conflict", name: projectName }], ignoredProjectId)
        setName(next)
        setNameEdited(true)
        setNameAdjusted(true)
        setNameError(t("nameAdjustedRetry"))
        return
      }
      toast.error(error instanceof Error ? error.message : t(editingProject ? "updateFailed" : "createFailed"))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const submit = () => {
    if (!editor || !name.trim() || savingRef.current) return
    normalizeName()
    if (!editingProject && existingWorkspace && existingWorkspace.name !== name.trim()) {
      setWorkspaceConflict(existingWorkspace)
      return
    }
    void persistProject()
  }

  return (
    <>
      <Dialog open={editor !== null} onOpenChange={(open) => { if (!savingRef.current) onOpenChange(open) }}>
        <DialogContent className="sm:max-w-lg">
          <form
            className="flex flex-col gap-6"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <DialogHeader>
              <DialogTitle>{t(editingProject ? "editTitle" : "createTitle")}</DialogTitle>
              <DialogDescription>
                {t(editingProject ? "editDescription" : "createDescription")}
              </DialogDescription>
            </DialogHeader>

            <FieldGroup>
              <Field data-disabled={Boolean(editingProject) || onlineConnectors.length === 0 || saving || undefined}>
                <FieldLabel htmlFor="project-device">{t("device")}</FieldLabel>
                {editingProject ? (
                  <Input id="project-device" value={selectedConnector?.name ?? editingProject.connectorId} disabled readOnly />
                ) : (
                  <Select
                    value={connectorId}
                    disabled={onlineConnectors.length === 0 || saving}
                    onValueChange={(value) => {
                      setConnectorId(value)
                      setPath("")
                      setBrowserOpen(false)
                      setNameError("")
                    }}
                  >
                    <SelectTrigger id="project-device" className="w-full">
                      <SelectValue placeholder={t("selectDevice")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {onlineConnectors.map((connector) => (
                          <SelectItem key={connector.id} value={connector.id}>{connector.name}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                )}
                {!editingProject && onlineConnectors.length === 0 ? <FieldDescription>{t("onlineDeviceRequired")}</FieldDescription> : null}
              </Field>
              <Field data-disabled={Boolean(editingProject) || !connectorId || saving || undefined}>
                <FieldLabel htmlFor="project-workspace">{t("workspace")}</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="project-workspace"
                    value={path}
                    maxLength={4096}
                    disabled={Boolean(editingProject) || !connectorId || saving}
                    readOnly={Boolean(editingProject)}
                    onChange={(event) => { setPath(event.currentTarget.value); setNameError("") }}
                    placeholder={tWorkspace("enterPath")}
                    className="min-w-0 code-mono text-xs"
                  />
                  {!editingProject ? (
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        size="icon-xs"
                        disabled={selectedConnector?.status !== "online" || saving}
                        aria-label={tWorkspace("browseFilesystem")}
                        title={tWorkspace("browseFilesystem")}
                        onClick={() => setBrowserOpen(true)}
                      >
                        <FolderOpen />
                      </InputGroupButton>
                    </InputGroupAddon>
                  ) : null}
                </InputGroup>
                {editingProject ? <FieldDescription>{t("workspaceImmutable")}</FieldDescription> : null}
              </Field>
              <Field data-invalid={Boolean(nameError) || undefined}>
                <FieldLabel htmlFor="project-name">{t("name")}</FieldLabel>
                <Input
                  id="project-name"
                  value={name}
                  maxLength={255}
                  disabled={saving}
                  aria-invalid={Boolean(nameError) || undefined}
                  aria-describedby={nameError ? "project-name-error" : "project-name-description"}
                  onChange={(event) => {
                    setName(event.currentTarget.value)
                    setNameEdited(true)
                    setNameAdjusted(false)
                    setNameError("")
                  }}
                  onBlur={normalizeName}
                  placeholder={t("namePlaceholder")}
                />
                <FieldDescription id="project-name-description">{t(nameAdjusted ? "nameAdjusted" : "nameDescription")}</FieldDescription>
                <FieldError id="project-name-error">{nameError}</FieldError>
              </Field>
            </FieldGroup>

            <DialogFooter>
              <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
                {tCommon("cancel")}
              </Button>
              <Button
                type="submit"
                disabled={saving || name.trim().length === 0 || (!editingProject && (selectedConnector?.status !== "online" || !path.trim()))}
              >
                {saving ? <Spinner data-icon="inline-start" /> : null}
                {editingProject ? tCommon("save") : t("create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <FileBrowserDialog
        open={browserOpen && Boolean(editor) && !editingProject}
        onOpenChange={setBrowserOpen}
        connectorId={connectorId}
        connectorDeviceOs={selectedConnector?.deviceOs}
        token={session?.accessToken}
        initialPath={path.trim() || "~"}
        onConfirm={(next) => { setPath(next); setNameError("") }}
      />

      <AlertDialog
        open={workspaceConflict !== null}
        onOpenChange={(open) => {
          if (!open) setWorkspaceConflict(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("workspaceConflictTitle")}</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              {t("workspaceConflictDescription", {
                currentName: workspaceConflict?.name ?? "",
                name: name.trim(),
                path: workspaceConflict?.workspacePath ?? path,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>
              {t("workspaceConflictBack")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={() => {
                setWorkspaceConflict(null)
                void persistProject()
              }}
            >
              {t("workspaceConflictConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
