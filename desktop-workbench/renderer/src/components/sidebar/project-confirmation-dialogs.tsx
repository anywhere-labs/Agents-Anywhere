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
  onProjectToArchiveChange: (project: ProjectView | null) => void
  onArchiveProjectSessions: (projectId: string) => Promise<boolean>
}

export function ProjectConfirmationDialogs({
  projectToArchive,
  onProjectToArchiveChange,
  onArchiveProjectSessions,
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
              variant="destructive"
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
    </>
  )
}
