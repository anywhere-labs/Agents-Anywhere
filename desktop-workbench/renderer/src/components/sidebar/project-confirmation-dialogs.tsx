"use client"

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
import type { ProjectView } from "@/features/dashboard/types"
import { useTranslations } from "next-intl"

type ProjectConfirmationDialogsProps = {
  projectToArchive: ProjectView | null
  projectToRemove: ProjectView | null
  onProjectToArchiveChange: (project: ProjectView | null) => void
  onProjectToRemoveChange: (project: ProjectView | null) => void
  onArchiveProjectSessions: (projectId: string) => Promise<boolean>
  onRemoveProject: (projectId: string) => Promise<boolean>
}

export function ProjectConfirmationDialogs({
  projectToArchive,
  projectToRemove,
  onProjectToArchiveChange,
  onProjectToRemoveChange,
  onArchiveProjectSessions,
  onRemoveProject,
}: ProjectConfirmationDialogsProps) {
  const t = useTranslations("dashboard")
  const tCommon = useTranslations("common")

  return (
    <>
      <AlertDialog
        open={projectToArchive !== null}
        onOpenChange={(open) => {
          if (!open) onProjectToArchiveChange(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("projects.archiveAllTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("projects.archiveAllDescription", { name: projectToArchive?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const project = projectToArchive
                onProjectToArchiveChange(null)
                if (!project) return
                void onArchiveProjectSessions(project.id).then((ok) => {
                  if (ok) toast.success(t("projects.archiveAllSuccess"))
                  else toast.error(t("projects.archiveAllFailed"))
                })
              }}
            >
              {t("projects.archiveAll")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={projectToRemove !== null}
        onOpenChange={(open) => {
          if (!open) onProjectToRemoveChange(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("projects.removeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("projects.removeDescription", { name: projectToRemove?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const project = projectToRemove
                onProjectToRemoveChange(null)
                if (!project) return
                void onRemoveProject(project.id).then((ok) => {
                  if (ok) toast.success(t("projects.removeSuccess"))
                  else toast.error(t("projects.removeFailed"))
                })
              }}
            >
              {t("projects.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
