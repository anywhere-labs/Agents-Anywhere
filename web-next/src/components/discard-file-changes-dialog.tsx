"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"

export function useDiscardFileChanges() {
  const t = useTranslations("preview")
  const [open, setOpen] = React.useState(false)
  const pending = React.useRef<((discard: boolean) => void) | null>(null)
  const finish = React.useCallback((discard: boolean) => {
    pending.current?.(discard)
    pending.current = null
    setOpen(false)
  }, [])
  React.useEffect(() => () => pending.current?.(false), [])
  const confirmDiscard = React.useCallback(() => new Promise<boolean>((resolve) => {
    pending.current?.(false)
    pending.current = resolve
    setOpen(true)
  }), [])

  return {
    confirmDiscard,
    discardDialog: (
      <AlertDialog open={open} onOpenChange={(value) => { if (!value) finish(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("discardTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("discardDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => finish(false)}>{t("keepEditing")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => finish(true)}>{t("discardChanges")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  }
}
