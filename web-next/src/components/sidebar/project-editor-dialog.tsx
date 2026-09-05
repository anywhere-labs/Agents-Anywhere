"use client"

import * as React from "react"
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  WorkspacePicker,
  type WorkspaceSelection,
} from "@/components/workspace-picker"
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

function workspaceKey(path: string, deviceOs?: string | null): string {
  const slashNormalized = path.trim().replaceAll("\\", "/")
  const withoutTrailingSlash = slashNormalized.replace(/\/+$/, "") || "/"
  return deviceOs === "windows"
    ? withoutTrailingSlash.toLocaleLowerCase()
    : withoutTrailingSlash
}

export function ProjectEditorDialog({
  editor,
  connectors,
  projects,
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
  projects: ProjectView[]
  onOpenChange: (open: boolean) => void
  onCreate: (payload: ProjectCreateRequest) => Promise<ProjectView | null>
  onUpdate: (projectId: string, payload: ProjectPatchRequest) => Promise<ProjectView | null>
}) {
  const t = useTranslations("dashboard.projects")
  const tCommon = useTranslations("common")
  const [name, setName] = React.useState("")
  const [connectorId, setConnectorId] = React.useState("")
  const [workspace, setWorkspace] = React.useState<WorkspaceSelection | null>(null)
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
      setWorkspace({
        label: editor.project.name,
        path: editor.project.workspacePath,
        connectorId: editor.project.connectorId,
      })
    } else {
      setName("")
      setConnectorId(onlineConnectors[0]?.id ?? "")
      setWorkspace(null)
    }
    setSaving(false)
    setNameError("")
    setWorkspaceConflict(null)
  }, [editor])

  const persistProject = React.useCallback(async () => {
    const projectName = name.trim()
    if (!editor || !projectName || saving) return
    setSaving(true)
    try {
      const result = editor.mode === "edit"
        ? await onUpdate(editor.project.id, { name: projectName })
        : workspace?.path && connectorId
          ? await onCreate({
              name: projectName,
              connectorId,
              workspacePath: workspace.path,
            })
          : null
      if (!result) {
        toast.error(t(editor.mode === "edit" ? "updateFailed" : "createFailed"))
        return
      }
      toast.success(t(editor.mode === "edit" ? "updateSuccess" : "createSuccess"))
      onOpenChange(false)
    } catch (error) {
      if (isApiError(error) && error.code === "project_name_conflict") {
        setNameError(t("nameConflict", { name: projectName }))
        return
      }
      toast.error(t(editor.mode === "edit" ? "updateFailed" : "createFailed"))
    } finally {
      setSaving(false)
    }
  }, [connectorId, editor, name, onCreate, onOpenChange, onUpdate, saving, t, workspace?.path])

  const submit = React.useCallback(() => {
    const projectName = name.trim()
    if (!editor || !projectName || saving) return
    if (editor.mode === "create" && workspace?.path && connectorId) {
      const connector = connectors.find((item) => item.id === connectorId)
      const selectedWorkspaceKey = workspaceKey(workspace.path, connector?.deviceOs)
      const existingProject = projects.find(
        (project) => project.connectorId === connectorId
          && workspaceKey(project.workspacePath, connector?.deviceOs) === selectedWorkspaceKey,
      )
      if (existingProject) {
        setWorkspaceConflict(existingProject)
        return
      }
    }
    void persistProject()
  }, [connectorId, connectors, editor, name, persistProject, projects, saving, workspace?.path])

  return (
    <>
      <Dialog open={editor !== null} onOpenChange={onOpenChange}>
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
            <Field data-invalid={nameError ? true : undefined}>
              <FieldLabel htmlFor="project-name">{t("name")}</FieldLabel>
              <Input
                id="project-name"
                autoFocus
                value={name}
                maxLength={255}
                disabled={saving}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? "project-name-error" : undefined}
                onChange={(event) => {
                  setName(event.currentTarget.value)
                  setNameError("")
                }}
                placeholder={t("namePlaceholder")}
              />
              <FieldError id="project-name-error">{nameError}</FieldError>
            </Field>

            {editingProject ? (
              <>
                <Field data-disabled>
                  <FieldLabel htmlFor="project-device">{t("device")}</FieldLabel>
                  <Input
                    id="project-device"
                    value={selectedConnector?.name ?? editingProject.connectorId}
                    disabled
                    readOnly
                  />
                </Field>
                <Field data-disabled>
                  <FieldLabel htmlFor="project-workspace">{t("workspace")}</FieldLabel>
                  <Input
                    id="project-workspace"
                    className="code-mono text-xs"
                    value={editingProject.workspacePath}
                    disabled
                    readOnly
                  />
                  <FieldDescription>{t("workspaceImmutable")}</FieldDescription>
                </Field>
              </>
            ) : (
              <>
                <Field data-disabled={onlineConnectors.length === 0 || undefined}>
                  <FieldLabel>{t("device")}</FieldLabel>
                  <Select
                    value={connectorId}
                    disabled={onlineConnectors.length === 0 || saving}
                    onValueChange={(value) => {
                      setConnectorId(value)
                      setWorkspace(null)
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t("selectDevice")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {onlineConnectors.map((connector) => (
                          <SelectItem key={connector.id} value={connector.id}>
                            {connector.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {onlineConnectors.length === 0 ? (
                    <FieldDescription>{t("onlineDeviceRequired")}</FieldDescription>
                  ) : null}
                </Field>
                <Field data-disabled={!connectorId || undefined}>
                  <FieldLabel>{t("workspace")}</FieldLabel>
                  {connectorId ? (
                    <WorkspacePicker
                      connectorId={connectorId}
                      value={workspace}
                      onChange={setWorkspace}
                    />
                  ) : (
                    <FieldDescription>{t("selectDeviceFirst")}</FieldDescription>
                  )}
                </Field>
              </>
            )}
          </FieldGroup>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
              {tCommon("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={saving || name.trim().length === 0 || (!editingProject && (!connectorId || !workspace?.path))}
            >
              {saving ? <Spinner data-icon="inline-start" /> : null}
              {tCommon("save")}
            </Button>
          </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
                path: workspaceConflict?.workspacePath ?? workspace?.path ?? "",
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
