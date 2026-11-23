"use client"

import { useEffect, useId, useRef, useState, type FormEvent } from "react"

import { driveErrorMessage, driveNameProblemMessage } from "@/components/drive/drive-labels"
import { Field } from "@/components/field"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { checkDriveName, cleanDriveName, driveStemLength } from "@/lib/drive/paths"

export interface DriveNameDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  label: string
  submitLabel: string
  initialName?: string
  /** Select only the part before the extension (renaming a file). */
  selectStem?: boolean
  /** Throws to keep the dialog open with the error shown. */
  onSubmit: (name: string) => Promise<void>
}

/**
 * Asks for one file or folder name (new folder, rename), checking it before the server does. The form mounts with the
 * dialog each time it opens (closed dialogs leave the DOM), so it starts from `initialName`; give the dialog a new
 * `key` per opening if it can reopen before it has finished closing.
 */
export function DriveNameDialog({ open, onOpenChange, ...form }: DriveNameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <NameForm {...form} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function NameForm({
  title,
  description,
  label,
  submitLabel,
  initialName = "",
  selectStem = false,
  onSubmit,
  onCancel,
}: Omit<DriveNameDialogProps, "open" | "onOpenChange"> & { onCancel: () => void }) {
  const { t } = useI18n()
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initialName)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    if (selectStem) input.setSelectionRange(0, driveStemLength(initialName))
    else input.select()
  }, [initialName, selectStem])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const problem = checkDriveName(value)
    if (problem) {
      setError(driveNameProblemMessage(problem, t))
      return
    }
    const name = cleanDriveName(value)
    setPending(true)
    setError(null)
    try {
      await onSubmit(name)
    } catch (err) {
      setError(driveErrorMessage(err, t, name))
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="grid gap-6" onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      <div className="grid gap-2">
        <Field label={label} htmlFor={inputId}>
          <Input
            ref={inputRef}
            id={inputId}
            value={value}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setValue(event.target.value)
              if (error) setError(null)
            }}
          />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}
