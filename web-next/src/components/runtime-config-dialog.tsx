"use client"

import * as React from "react"
import Ajv2020 from "ajv/dist/2020"
import { Plus, RotateCcw, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"

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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

type JsonSchema = {
  type?: string
  title?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean | JsonSchema
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  [key: string]: unknown
}

type UiField = {
  component?: string
  [key: string]: unknown
}

type RuntimeConfigDialogProps = {
  runtimeName: string
  schema: Record<string, unknown> | null
  uiSchema: Record<string, unknown>
  config: Record<string, unknown> | null
  open: boolean
  saving: boolean
  onOpenChange: (open: boolean) => void
  onSave: (config: Record<string, unknown>) => Promise<void>
}

export function RuntimeConfigDialog({
  runtimeName,
  schema,
  uiSchema,
  config,
  open,
  saving,
  onOpenChange,
  onSave,
}: RuntimeConfigDialogProps) {
  const t = useTranslations("dashboard.device")
  const tCommon = useTranslations("common")
  const [draft, setDraft] = React.useState<Record<string, unknown>>(config ?? {})
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [resetKey, setResetKey] = React.useState(0)

  React.useEffect(() => {
    if (!open) return
    setDraft(config ?? {})
    setErrors({})
    setResetKey((value) => value + 1)
  }, [config, open])

  const typedSchema = schema as JsonSchema | null
  const properties = typedSchema?.properties ?? {}
  const required = new Set(typedSchema?.required ?? [])
  const uiOrder = Array.isArray(uiSchema.order)
    ? uiSchema.order.filter((key): key is string => typeof key === "string")
    : []
  const fieldNames = [
    ...uiOrder.filter((key) => key in properties),
    ...Object.keys(properties).filter((key) => !uiOrder.includes(key)),
  ]

  const patch = (key: string, value: unknown) => {
    setDraft((current) => {
      if (value !== undefined) return { ...current, [key]: value }
      const next = { ...current }
      delete next[key]
      return next
    })
    setErrors((current) => {
      if (!current[key]) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  const resetAll = () => {
    setDraft({})
    setErrors({})
    setResetKey((value) => value + 1)
  }

  const submit = async () => {
    if (!schema) return
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    const validate = ajv.compile(schema)
    if (!validate(draft)) {
      const next: Record<string, string> = {}
      for (const error of validate.errors ?? []) {
        const field = error.instancePath.split("/").filter(Boolean)[0] ?? "_root"
        next[field] ??= error.message ?? t("runtimeConfigInvalid")
      }
      setErrors(next)
      return
    }
    await onSave(draft)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(42rem,calc(100dvh-2rem))] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("runtimeConfigTitle", { name: runtimeName })}</DialogTitle>
          <DialogDescription>{t("runtimeConfigDescription")}</DialogDescription>
        </DialogHeader>

        {!typedSchema ? (
          <FieldError>{t("runtimeSchemaUnavailable")}</FieldError>
        ) : (
          <FieldGroup className="py-2">
            {fieldNames.map((key) => {
              const field = properties[key]
              if (!field) return null
              const uiField = isRecord(uiSchema[key]) ? (uiSchema[key] as UiField) : {}
              return (
                <RuntimeConfigField
                  key={`${key}:${resetKey}`}
                  name={key}
                  schema={field}
                  ui={uiField}
                  value={draft[key]}
                  required={required.has(key)}
                  error={errors[key]}
                  onChange={(value) => patch(key, value)}
                />
              )
            })}
            {errors._root ? <FieldError>{errors._root}</FieldError> : null}
          </FieldGroup>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="ghost" onClick={resetAll} disabled={saving || !schema}>
            <RotateCcw />
            {t("resetAllDefaults")}
          </Button>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {tCommon("cancel")}
            </Button>
            <Button type="button" onClick={() => void submit()} disabled={saving || !schema}>
              {saving ? t("saving") : tCommon("save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RuntimeConfigField({
  name,
  schema,
  ui,
  value,
  required,
  error,
  onChange,
}: {
  name: string
  schema: JsonSchema
  ui: UiField
  value: unknown
  required: boolean
  error?: string
  onChange: (value: unknown) => void
}) {
  const title = schema.title ?? name
  const description = schema.description
  const inputId = `runtime-config-${name}`
  const effectiveValue = value === undefined ? schema.default : value

  if (ui.component === "keyValue" || (schema.type === "object" && isRecord(schema.additionalProperties))) {
    return (
      <Field data-invalid={Boolean(error)}>
        <FieldLabel>{title}{required ? " *" : ""}</FieldLabel>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
        <EnvironmentEditor value={isRecord(value) ? value : {}} onChange={onChange} />
        <FieldError>{error}</FieldError>
      </Field>
    )
  }

  if (schema.type === "boolean") {
    return (
      <Field orientation="horizontal" data-invalid={Boolean(error)}>
        <div className="min-w-0 flex-1">
          <FieldLabel htmlFor={inputId}>{title}{required ? " *" : ""}</FieldLabel>
          {description ? <FieldDescription>{description}</FieldDescription> : null}
          <FieldError>{error}</FieldError>
        </div>
        <Switch
          id={inputId}
          checked={Boolean(effectiveValue)}
          onCheckedChange={onChange}
          aria-invalid={Boolean(error)}
        />
      </Field>
    )
  }

  if (Array.isArray(schema.enum)) {
    return (
      <Field data-invalid={Boolean(error)}>
        <FieldLabel htmlFor={inputId}>{title}{required ? " *" : ""}</FieldLabel>
        <Select
          value={effectiveValue == null ? undefined : String(effectiveValue)}
          onValueChange={(next: string) => onChange(enumValue(schema.enum ?? [], next))}
        >
          <SelectTrigger id={inputId} className="w-full" aria-invalid={Boolean(error)}>
            <SelectValue placeholder={title} />
          </SelectTrigger>
          <SelectContent>
            {schema.enum.map((option) => (
              <SelectItem key={String(option)} value={String(option)}>{String(option)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
        <FieldError>{error}</FieldError>
      </Field>
    )
  }

  if (schema.type === "number" || schema.type === "integer") {
    return (
      <Field data-invalid={Boolean(error)}>
        <FieldLabel htmlFor={inputId}>{title}{required ? " *" : ""}</FieldLabel>
        <Input
          id={inputId}
          type="number"
          value={typeof effectiveValue === "number" ? effectiveValue : ""}
          min={schema.minimum}
          max={schema.maximum}
          step={schema.type === "integer" ? 1 : "any"}
          onChange={(event) => onChange(event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value))}
          aria-invalid={Boolean(error)}
        />
        {description ? <FieldDescription>{description}</FieldDescription> : null}
        <FieldError>{error}</FieldError>
      </Field>
    )
  }

  if (schema.type === "string" || ui.component === "path") {
    const placeholder = typeof schema.default === "string" ? schema.default : undefined
    return (
      <Field data-invalid={Boolean(error)}>
        <FieldLabel htmlFor={inputId}>{title}{required ? " *" : ""}</FieldLabel>
        <Input
          id={inputId}
          value={typeof value === "string" ? value : ""}
          placeholder={placeholder}
          minLength={schema.minLength}
          maxLength={schema.maxLength}
          onChange={(event) => {
            const next = event.currentTarget.value
            onChange(next || (required ? "" : undefined))
          }}
          aria-invalid={Boolean(error)}
          spellCheck={false}
        />
        {description ? <FieldDescription>{description}</FieldDescription> : null}
        <FieldError>{error}</FieldError>
      </Field>
    )
  }

  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={inputId}>{title}{required ? " *" : ""}</FieldLabel>
      <Textarea
        id={inputId}
        defaultValue={value === undefined ? "" : JSON.stringify(value, null, 2)}
        placeholder={schema.type === "array" ? "[]" : "{}"}
        onChange={(event) => {
          const raw = event.currentTarget.value.trim()
          if (!raw) {
            onChange(undefined)
            return
          }
          try {
            onChange(JSON.parse(raw))
          } catch {
            onChange(raw)
          }
        }}
        aria-invalid={Boolean(error)}
        className="min-h-28 font-mono text-xs"
        spellCheck={false}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError>{error}</FieldError>
    </Field>
  )
}

type EnvironmentRow = { id: number; key: string; value: string; removed: boolean }

function EnvironmentEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown>
  onChange: (value: unknown) => void
}) {
  const t = useTranslations("dashboard.device")
  const nextId = React.useRef(1)
  const [rows, setRows] = React.useState<EnvironmentRow[]>(() =>
    Object.entries(value).map(([key, item]) => ({
      id: nextId.current++,
      key,
      value: typeof item === "string" ? item : "",
      removed: item === null,
    })),
  )

  const update = (next: EnvironmentRow[]) => {
    setRows(next)
    const environment: Record<string, string | null> = {}
    for (const row of next) {
      if (!row.key.trim()) continue
      environment[row.key.trim()] = row.removed ? null : row.value
    }
    onChange(environment)
  }

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border p-3">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noEnvironmentOverrides")}</p>
      ) : rows.map((row) => (
        <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
          <Input
            value={row.key}
            onChange={(event) => update(rows.map((item) => item.id === row.id ? { ...item, key: event.currentTarget.value } : item))}
            placeholder={t("environmentName")}
            spellCheck={false}
            aria-label={t("environmentName")}
          />
          <Input
            value={row.value}
            onChange={(event) => update(rows.map((item) => item.id === row.id ? { ...item, value: event.currentTarget.value } : item))}
            placeholder={row.removed ? t("removeInherited") : t("environmentValue")}
            disabled={row.removed}
            spellCheck={false}
            aria-label={t("environmentValue")}
          />
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant={row.removed ? "secondary" : "ghost"}
              onClick={() => update(rows.map((item) => item.id === row.id ? { ...item, removed: !item.removed } : item))}
              title={t("removeInherited")}
            >
              {t("unset")}
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => update(rows.filter((item) => item.id !== row.id))}
              aria-label={t("removeEnvironmentVariable")}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => update([...rows, { id: nextId.current++, key: "", value: "", removed: false }])}
      >
        <Plus />
        {t("addEnvironmentVariable")}
      </Button>
    </div>
  )
}

function enumValue(options: unknown[], value: string) {
  return options.find((option) => String(option) === value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
