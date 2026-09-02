"use client"

import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"

export function RuntimeInstanceNameDialog({
  open,
  title,
  description,
  label,
  requiredMessage,
  placeholder,
  submitLabel,
  cancelLabel,
  initialName = "",
  saving,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  title: string
  description: string
  label: string
  requiredMessage: string
  placeholder: string
  submitLabel: string
  cancelLabel: string
  initialName?: string
  saving: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => Promise<void>
}) {
  const [draft, setDraft] = React.useState(initialName)
  const [submitted, setSubmitted] = React.useState(false)
  const name = draft.trim()
  const invalid = submitted && !name

  React.useEffect(() => {
    if (!open) return
    setDraft(initialName)
    setSubmitted(false)
  }, [initialName, open])

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitted(true)
    if (!name || saving) return
    try {
      await onSubmit(name)
    } catch {
      // The owner reports the request error and keeps the dialog open.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-5">
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor="runtime-instance-name">{label}</FieldLabel>
              <Input
                id="runtime-instance-name"
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
                placeholder={placeholder}
                maxLength={128}
                aria-invalid={invalid}
                autoFocus
              />
              {invalid ? <FieldError>{requiredMessage}</FieldError> : null}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {cancelLabel}
            </Button>
            <Button type="submit" disabled={saving || !name}>
              {saving ? <Spinner data-icon="inline-start" /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
