"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import type { CommandConfirmation, CommandConfirmationChoice } from "./runtime-command-model"

/** Asks before the device quits the app holding a session; closing the dialog counts as cancel. */
export function CommandConfirmationDialog({ confirmation, onChoose }: {
  confirmation: CommandConfirmation | null
  onChoose: (choice: CommandConfirmationChoice) => void
}) {
  const t = useTranslations("dashboard.session")
  const tCommon = useTranslations("common")
  const [force, setForce] = React.useState(false)
  React.useEffect(() => { setForce(false) }, [confirmation?.planId])
  const appName = confirmation?.appName ?? ""
  return (
    <Dialog open={confirmation !== null} onOpenChange={(open: boolean) => { if (!open) onChoose("cancel") }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("appQuitTitle", { appName })}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-2">
              <p>{t("appQuitDescription", {
                appName,
                processCount: confirmation?.processCount ?? 0,
                seconds: Math.ceil((confirmation?.gracePeriodMs ?? 0) / 1000),
              })}</p>
              <p>{t("appQuitAfter")}</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        {confirmation?.forceArgs.length ? (
          <Field orientation="horizontal">
            <Checkbox id={`app-quit-force-${confirmation.planId}`} checked={force} onCheckedChange={value => setForce(value === true)} />
            <FieldLabel htmlFor={`app-quit-force-${confirmation.planId}`}>{t("appQuitForce")}</FieldLabel>
          </Field>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onChoose("cancel")}>{tCommon("cancel")}</Button>
          <Button variant="destructive" onClick={() => onChoose(force ? "force" : "confirm")}>{t("appQuitConfirm", { appName })}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
