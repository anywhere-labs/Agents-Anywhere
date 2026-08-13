"use client"

import * as React from "react"
import Ajv2020 from "ajv/dist/2020"
import { Eye, EyeOff, Plus, RotateCcw, Trash2, X } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectGroup,
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
  items?: JsonSchema
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
  formKey: string
  runtimeName: string
  title?: string
  description?: string
  schema: Record<string, unknown> | null
  uiSchema: Record<string, unknown>
  defaults?: Record<string, unknown>
  config: Record<string, unknown> | null
  instanceFields?: RuntimeInstanceFields
  open: boolean
  saving: boolean
  submitLabel?: string
  onOpenChange: (open: boolean) => void
  onSave: (config: Record<string, unknown>) => Promise<void>
}

export type RuntimeInstanceFields = {
  runtimeType: string
  runtimeTypes: Array<{
    value: string
    label: string
  }>
  name: string
  startImmediately: boolean
  onRuntimeTypeChange: (runtimeType: string) => void
  onNameChange: (name: string) => void
  onStartImmediatelyChange: (active: boolean) => void
}

const RUNTIME_CONFIG_COMPONENT_COPY: Record<string, { titleKey: string; descriptionKey?: string }> = {
  keyValue: {
    titleKey: "runtimeConfigComponents.keyValue.label",
    descriptionKey: "runtimeConfigComponents.keyValue.description",
  },
  customModels: {
    titleKey: "runtimeConfigComponents.customModels.label",
    descriptionKey: "runtimeConfigComponents.customModels.description",
  },
  modelGateway: {
    titleKey: "runtimeConfigComponents.modelGateway.label",
    descriptionKey: "runtimeConfigComponents.modelGateway.description",
  },
  path: {
    titleKey: "runtimeConfigComponents.path.label",
    descriptionKey: "runtimeConfigComponents.path.description",
  },
}

export function RuntimeConfigDialog({
  formKey,
  runtimeName,
  title,
  description,
  schema,
  uiSchema,
  defaults = {},
  config,
  instanceFields,
  open,
  saving,
  submitLabel,
  onOpenChange,
  onSave,
}: RuntimeConfigDialogProps) {
  const t = useTranslations("dashboard.device")
  const tCommon = useTranslations("common")
  const [draft, setDraft] = React.useState<Record<string, unknown>>(() => initialConfig(defaults, config))
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [instanceNameInvalid, setInstanceNameInvalid] = React.useState(false)
  const [resetKey, setResetKey] = React.useState(0)

  React.useEffect(() => {
    if (!open) return
    setDraft(initialConfig(defaults, config))
    setErrors({})
    setInstanceNameInvalid(false)
    setResetKey((value) => value + 1)
  }, [formKey, open])

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
    setDraft({ ...defaults })
    setErrors({})
    setResetKey((value) => value + 1)
  }

  const submit = async () => {
    if (instanceFields && !instanceFields.name.trim()) {
      setInstanceNameInvalid(true)
      return
    }
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
    try {
      await onSave(draft)
      onOpenChange(false)
    } catch {
      // The caller reports the request error and refreshes persisted runtime state.
    }
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} direction="right">
      <DrawerContent
        className="data-[vaul-drawer-direction=right]:w-[min(42rem,calc(100vw-1rem))] data-[vaul-drawer-direction=right]:sm:max-w-2xl"
      >
        <DrawerHeader className="px-6 py-5 pr-16">
          <DrawerTitle className="text-xl">{title ?? t("runtimeConfigTitle", { name: runtimeName })}</DrawerTitle>
          {description ? <DrawerDescription>{description}</DrawerDescription> : null}
        </DrawerHeader>
        <DrawerClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute right-8 top-8 bg-secondary"
          >
            <X />
            <span className="sr-only">{tCommon("close")}</span>
          </Button>
        </DrawerClose>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
          {instanceFields ? (
            <>
              <FieldGroup className="gap-5">
                <Field>
                  <FieldLabel htmlFor="runtime-instance-type">{t("runtimeType")}</FieldLabel>
                  <Select
                    value={instanceFields.runtimeType}
                    onValueChange={instanceFields.onRuntimeTypeChange}
                  >
                    <SelectTrigger id="runtime-instance-type" className="w-full">
                      <SelectValue placeholder={t("selectRuntimeType")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {instanceFields.runtimeTypes.map((runtimeType) => (
                          <SelectItem key={runtimeType.value} value={runtimeType.value}>
                            {runtimeType.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field data-invalid={instanceNameInvalid}>
                  <FieldLabel htmlFor="runtime-instance-name">{t("runtimeInstanceName")}</FieldLabel>
                  <Input
                    id="runtime-instance-name"
                    value={instanceFields.name}
                    onChange={(event) => {
                      instanceFields.onNameChange(event.currentTarget.value)
                      if (event.currentTarget.value.trim()) setInstanceNameInvalid(false)
                    }}
                    placeholder={t("runtimeInstanceNamePlaceholder")}
                    maxLength={128}
                    aria-invalid={instanceNameInvalid}
                    autoFocus
                  />
                  <FieldDescription>{t("runtimeInstanceNameDescription")}</FieldDescription>
                  {instanceNameInvalid ? <FieldError>{t("runtimeInstanceNameRequired")}</FieldError> : null}
                </Field>
                <Field orientation="horizontal">
                  <div className="min-w-0 flex-1">
                    <FieldLabel htmlFor="runtime-start-immediately">{t("startImmediately")}</FieldLabel>
                    <FieldDescription>{t("startImmediatelyDescription")}</FieldDescription>
                  </div>
                  <Switch
                    id="runtime-start-immediately"
                    checked={instanceFields.startImmediately}
                    onCheckedChange={instanceFields.onStartImmediatelyChange}
                  />
                </Field>
              </FieldGroup>
              <Separator className="my-6" />
            </>
          ) : null}
          {!typedSchema ? (
            <FieldError>{t("runtimeSchemaUnavailable")}</FieldError>
          ) : (
            <FieldGroup className="gap-6">
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
        </div>

        <DrawerFooter className="px-6 pb-6 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <Button type="button" variant="ghost" onClick={resetAll} disabled={saving || !schema}>
            <RotateCcw />
            {t("resetAllDefaults")}
          </Button>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {tCommon("cancel")}
            </Button>
            <Button type="button" onClick={() => void submit()} disabled={saving || !schema}>
              {saving ? t("saving") : submitLabel ?? tCommon("save")}
            </Button>
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}

function initialConfig(
  defaults: Record<string, unknown>,
  config: Record<string, unknown> | null,
): Record<string, unknown> {
  return { ...defaults, ...(config ?? {}) }
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
  const t = useTranslations("dashboard.device")
  const tRoot = useTranslations()
  const component = runtimeConfigComponent(schema, ui)
  const componentCopy = RUNTIME_CONFIG_COMPONENT_COPY[component ?? ""]
  const title = schemaI18nText(tRoot, schema, "labelKey")
    ?? (componentCopy ? t(componentCopy.titleKey) : schema.title ?? name)
  const description = schemaI18nText(tRoot, schema, "descriptionKey")
    ?? (componentCopy?.descriptionKey ? t(componentCopy.descriptionKey) : schema.description)
  const inputId = `runtime-config-${name}`
  const effectiveValue = value === undefined ? schema.default : value

  if (ui.component === "customModels") {
    return (
      <Field data-invalid={Boolean(error)}>
        <FieldLabel>{title}{required ? " *" : ""}</FieldLabel>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
        <CustomModelsEditor
          value={Array.isArray(effectiveValue) ? effectiveValue : []}
          onChange={onChange}
          invalid={Boolean(error)}
        />
        <FieldError>{error}</FieldError>
      </Field>
    )
  }

  if (ui.component === "modelGateway") {
    return (
      <Field data-invalid={Boolean(error)}>
        <FieldLabel>{title}{required ? " *" : ""}</FieldLabel>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
        <ModelGatewayEditor
          idPrefix={inputId}
          schema={schema}
          value={isRecord(effectiveValue) ? effectiveValue : {}}
          onChange={onChange}
          invalid={Boolean(error)}
        />
        <FieldError>{error}</FieldError>
      </Field>
    )
  }

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

function runtimeConfigComponent(schema: JsonSchema, ui: UiField): string | undefined {
  if (typeof ui.component === "string" && ui.component) return ui.component
  if (schema.type === "object" && isRecord(schema.additionalProperties)) return "keyValue"
  return undefined
}

function schemaI18nText(
  translate: (key: string) => string,
  schema: JsonSchema,
  field: "labelKey" | "descriptionKey",
): string | undefined {
  const metadata = schema.metadata
  if (!isRecord(metadata)) return undefined
  const i18n = metadata.i18n
  if (!isRecord(i18n)) return undefined
  const key = i18n[field]
  if (typeof key !== "string" || !key) return undefined
  try {
    const translated = translate(key)
    return translated === key ? undefined : translated
  } catch {
    return undefined
  }
}

function ModelGatewayEditor({
  idPrefix,
  schema,
  value,
  onChange,
  invalid,
}: {
  idPrefix: string
  schema: JsonSchema
  value: Record<string, unknown>
  onChange: (value: unknown) => void
  invalid: boolean
}) {
  const t = useTranslations("dashboard.device")
  const tRoot = useTranslations()
  const [showApiKey, setShowApiKey] = React.useState(false)
  const baseUrlSchema = schema.properties?.baseUrl ?? {}
  const apiKeySchema = schema.properties?.apiKey ?? {}
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl : ""
  const apiKey = typeof value.apiKey === "string" ? value.apiKey : ""
  const baseUrlLabel = schemaI18nText(tRoot, baseUrlSchema, "labelKey")
    ?? baseUrlSchema.title
    ?? t("modelGatewayBaseUrl")
  const apiKeyLabel = schemaI18nText(tRoot, apiKeySchema, "labelKey")
    ?? apiKeySchema.title
    ?? t("modelGatewayApiKey")
  const baseUrlDescription = schemaI18nText(tRoot, baseUrlSchema, "descriptionKey")
    ?? baseUrlSchema.description
  const apiKeyDescription = schemaI18nText(tRoot, apiKeySchema, "descriptionKey")
    ?? apiKeySchema.description
  const baseUrlId = `${idPrefix}-base-url`
  const apiKeyId = `${idPrefix}-api-key`

  const update = (patch: { baseUrl?: string; apiKey?: string }) => {
    const nextBaseUrl = patch.baseUrl ?? baseUrl
    const nextApiKey = patch.apiKey ?? apiKey
    if (!nextBaseUrl && !nextApiKey) {
      onChange(undefined)
      return
    }
    onChange({ baseUrl: nextBaseUrl, apiKey: nextApiKey })
  }

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border p-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor={baseUrlId} className="text-xs font-medium text-muted-foreground">{baseUrlLabel}</label>
        <Input
          id={baseUrlId}
          value={baseUrl}
          onChange={(event) => update({ baseUrl: event.currentTarget.value })}
          minLength={baseUrlSchema.minLength}
          maxLength={baseUrlSchema.maxLength}
          aria-invalid={invalid}
          autoComplete="url"
          inputMode="url"
          spellCheck={false}
        />
        {baseUrlDescription ? (
          <span className="text-xs text-muted-foreground">{baseUrlDescription}</span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor={apiKeyId} className="text-xs font-medium text-muted-foreground">{apiKeyLabel}</label>
        <InputGroup>
          <InputGroupInput
            id={apiKeyId}
            type={showApiKey ? "text" : "password"}
            value={apiKey}
            onChange={(event) => update({ apiKey: event.currentTarget.value })}
            minLength={apiKeySchema.minLength}
            maxLength={apiKeySchema.maxLength}
            aria-invalid={invalid}
            autoComplete="off"
            spellCheck={false}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              onClick={() => setShowApiKey((current) => !current)}
              aria-label={showApiKey ? t("hideModelGatewayApiKey") : t("showModelGatewayApiKey")}
            >
              {showApiKey ? <EyeOff /> : <Eye />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {apiKeyDescription ? (
          <span className="text-xs text-muted-foreground">{apiKeyDescription}</span>
        ) : null}
      </div>
    </div>
  )
}

type EnvironmentRow = { id: number; key: string; value: string; removed: boolean }

type CustomEffortRow = { id: number; effortId: string; displayName: string }
type CustomModelRow = {
  id: number
  modelId: string
  displayName: string
  efforts: CustomEffortRow[]
}

function CustomModelsEditor({
  value,
  onChange,
  invalid,
}: {
  value: unknown[]
  onChange: (value: unknown) => void
  invalid: boolean
}) {
  const t = useTranslations("dashboard.device")
  const nextId = React.useRef(1)
  const [rows, setRows] = React.useState<CustomModelRow[]>(() =>
    value
      .filter(isRecord)
      .map((item) => ({
        id: nextId.current++,
        modelId: typeof item.modelId === "string" ? item.modelId : "",
        displayName: typeof item.displayName === "string" ? item.displayName : "",
        efforts: Array.isArray(item.efforts)
          ? item.efforts.filter(isRecord).map((effort) => ({
            id: nextId.current++,
            effortId: typeof effort.effortId === "string" ? effort.effortId : "",
            displayName: typeof effort.displayName === "string" ? effort.displayName : "",
          }))
          : [],
      })),
  )

  const update = (next: CustomModelRow[]) => {
    setRows(next)
    const customModels = next.flatMap((row) => {
      const modelId = row.modelId.trim()
      const displayName = row.displayName.trim()
      const efforts = row.efforts.flatMap((effort) => {
        const effortId = effort.effortId.trim()
        const effortName = effort.displayName.trim()
        if (!effortId && !effortName) return []
        return [{ effortId, displayName: effortName }]
      })
      if (!modelId && !displayName && efforts.length === 0) return []
      return efforts.length > 0
        ? [{ modelId, displayName, efforts }]
        : [{ modelId, displayName }]
    })
    onChange(customModels)
  }

  const addEffort = (modelId: number) => {
    update(rows.map((row) => row.id === modelId
      ? {
        ...row,
        efforts: [
          ...row.efforts,
          { id: nextId.current++, effortId: "", displayName: "" },
        ],
      }
      : row))
  }

  const updateEffort = (
    modelId: number,
    effortId: number,
    patch: Partial<Omit<CustomEffortRow, "id">>,
  ) => {
    update(rows.map((row) => row.id === modelId
      ? {
        ...row,
        efforts: row.efforts.map((effort) => effort.id === effortId
          ? { ...effort, ...patch }
          : effort),
      }
      : row))
  }

  const removeEffort = (modelId: number, effortId: number) => {
    update(rows.map((row) => row.id === modelId
      ? {
        ...row,
        efforts: row.efforts.filter((effort) => effort.id !== effortId),
      }
      : row))
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-muted/10 p-4">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noCustomModels")}</p>
      ) : rows.map((row) => (
        <div
          key={row.id}
          className="flex flex-col gap-3 rounded-md border border-border/80 bg-background/40 p-3"
        >
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t("customModelId")}</span>
              <Input
                value={row.modelId}
                onChange={(event) => update(rows.map((item) => item.id === row.id ? { ...item, modelId: event.currentTarget.value } : item))}
                spellCheck={false}
                aria-label={t("customModelId")}
                aria-invalid={invalid}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t("customModelDisplayName")}</span>
              <Input
                value={row.displayName}
                onChange={(event) => update(rows.map((item) => item.id === row.id ? { ...item, displayName: event.currentTarget.value } : item))}
                spellCheck={false}
                aria-label={t("customModelDisplayName")}
                aria-invalid={invalid}
              />
            </label>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="self-end"
              onClick={() => update(rows.filter((item) => item.id !== row.id))}
              aria-label={t("removeCustomModel")}
            >
              <Trash2 />
            </Button>
          </div>
          <div className="flex flex-col gap-3 rounded-md border border-border/70 bg-muted/10 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">{t("customModelEfforts")}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => addEffort(row.id)}
              >
                <Plus data-icon="inline-start" />
                {t("addCustomEffort")}
              </Button>
            </div>
            {row.efforts.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noCustomEfforts")}</p>
            ) : row.efforts.map((effort) => (
              <div key={effort.id} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <label className="flex min-w-0 flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{t("customEffortId")}</span>
                  <Input
                    value={effort.effortId}
                    onChange={(event) => updateEffort(row.id, effort.id, { effortId: event.currentTarget.value })}
                    spellCheck={false}
                    aria-label={t("customEffortId")}
                    aria-invalid={invalid}
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{t("customEffortDisplayName")}</span>
                  <Input
                    value={effort.displayName}
                    onChange={(event) => updateEffort(row.id, effort.id, { displayName: event.currentTarget.value })}
                    spellCheck={false}
                    aria-label={t("customEffortDisplayName")}
                    aria-invalid={invalid}
                  />
                </label>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="self-end"
                  onClick={() => removeEffort(row.id, effort.id)}
                  aria-label={t("removeCustomEffort")}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => update([...rows, { id: nextId.current++, modelId: "", displayName: "", efforts: [] }])}
      >
        <Plus data-icon="inline-start" />
        {t("addCustomModel")}
      </Button>
    </div>
  )
}

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
