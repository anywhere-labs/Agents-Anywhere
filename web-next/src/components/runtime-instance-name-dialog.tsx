"use client"

import * as React from "react"

import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
  submitDisabled = false,
  secondaryAction,
  notice,
  errorMessage,
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
  submitDisabled?: boolean
  secondaryAction?: { label: string; onSubmit: (name: string) => Promise<void> }
  notice?: React.ReactNode
  errorMessage?: string | null
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => Promise<void>
}) {
  const [draft, setDraft] = React.useState(initialName)
  const [submitted, setSubmitted] = React.useState(false)
  const submitting = React.useRef(false)
  const inputId = React.useId()
  const name = draft.trim()
  const invalid = submitted && !name

  React.useEffect(() => {
    if (!open) return
    setDraft(initialName)
    setSubmitted(false)
  }, [initialName, open])

  const submit = async (action: (name: string) => Promise<void>) => {
    setSubmitted(true)
    if (!name || saving || submitDisabled || submitting.current) return
    submitting.current = true
    try {
      await action(name)
    } catch {
      // The owner reports the request error and keeps the dialog open.
    } finally {
      submitting.current = false
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!saving) onOpenChange(nextOpen) }}>
      <DialogContent showCloseButton={!saving}>
        <form onSubmit={(event) => { event.preventDefault(); void submit(onSubmit) }}>
          <DialogHeader className="pr-8">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-5">
            <Field data-invalid={invalid} data-disabled={saving}>
              <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
              <Input
                id={inputId}
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
                placeholder={placeholder}
                maxLength={128}
                aria-invalid={invalid}
                disabled={saving}
                autoFocus
              />
              {invalid ? <FieldError>{requiredMessage}</FieldError> : null}
            </Field>
            {notice}
            {errorMessage ? <Alert variant="destructive"><AlertDescription>{errorMessage}</AlertDescription></Alert> : null}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant={secondaryAction ? "ghost" : "outline"} className={secondaryAction ? "sm:mr-auto" : undefined} onClick={() => onOpenChange(false)} disabled={saving}>
              {cancelLabel}
            </Button>
            {secondaryAction ? (
              <Button type="button" variant="outline" disabled={saving || submitDisabled || !name} onClick={() => void submit(secondaryAction.onSubmit)}>
                {secondaryAction.label}
              </Button>
            ) : null}
            <Button type="submit" disabled={saving || submitDisabled || !name}>
              {saving ? <Spinner data-icon="inline-start" /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
