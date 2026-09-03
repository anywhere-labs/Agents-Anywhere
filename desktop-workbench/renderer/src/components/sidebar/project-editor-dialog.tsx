"use client"

import * as React from "react"
import { toast } from "sonner"
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
import { useTranslations } from "next-intl"

export type ProjectEditorState =
  | { mode: "create" }
  | { mode: "edit"; project: ProjectView }
  | null

export function ProjectEditorDialog({
  editor,
  connectors,
  onOpenChange,
  onCreate,
  onUpdate,
}: {
  editor: ProjectEditorState
  connectors: Array<{ id: string; name: string; status: string }>
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
  const editingProject = editor?.mode === "edit" ? editor.project : null
  const onlineConnectors = connectors.filter((connector) => connector.status === "online")
  const selectedConnector = connectors.find((connector) => connector.id === connectorId)

  React.useEffect(() => {
    if (!editor) return
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
  }, [editor])

  const submit = React.useCallback(async () => {
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
              attachMatchingSessions: true,
            })
          : null
      if (!result) {
        toast.error(t(editor.mode === "edit" ? "updateFailed" : "createFailed"))
        return
      }
      toast.success(t(editor.mode === "edit" ? "updateSuccess" : "createSuccess"))
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }, [connectorId, editor, name, onCreate, onOpenChange, onUpdate, saving, t, workspace?.path])

  return (
    <Dialog open={editor !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>{t(editingProject ? "editTitle" : "createTitle")}</DialogTitle>
            <DialogDescription>
              {t(editingProject ? "editDescription" : "createDescription")}
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-name">{t("name")}</FieldLabel>
              <Input
                id="project-name"
                autoFocus
                value={name}
                maxLength={255}
                disabled={saving}
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder={t("namePlaceholder")}
              />
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
  )
}
