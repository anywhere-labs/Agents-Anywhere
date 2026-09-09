"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { RuntimeConfigDialog } from "@/components/runtime-config-dialog"
import { RuntimeInstanceNameDialog } from "@/components/runtime-instance-name-dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { quickAddRuntime } from "@/features/dashboard/quick-add-runtime"
import {
  namedInstanceRequiredConfigFields,
  reconfigurableRuntimeInstance,
  runtimeConfigDraft,
  runtimeCreationDefaults,
  runtimeInstanceName,
  suggestedRuntimeInstanceName,
} from "@/features/dashboard/runtime-instances"
import type { DeviceRuntimeView, RuntimeTypeView } from "@/features/dashboard/types"

export function RuntimeAddDialog({
  runtimeType,
  runtimes,
  token,
  connectorId,
  onOpenChange,
  onRuntimeUpdated,
}: {
  runtimeType: RuntimeTypeView
  runtimes: DeviceRuntimeView[]
  token: string
  connectorId: string
  onOpenChange: (open: boolean) => void
  onRuntimeUpdated: (runtime: DeviceRuntimeView) => void
}) {
  const t = useTranslations("dashboard.device")
  const tCommon = useTranslations("common")
  const [initial] = React.useState(() => {
    const existing = reconfigurableRuntimeInstance(runtimeType, runtimes)
    const otherRuntimes = runtimes.filter((runtime) => runtime.runtimeId !== existing?.runtimeId)
    const previousName = existing ? runtimeInstanceName(existing) : null
    return {
      runtimeId: existing?.runtimeId,
      name: previousName && previousName !== runtimeType.displayName
        ? previousName
        : suggestedRuntimeInstanceName(runtimeType, otherRuntimes),
      config: existing ? runtimeConfigDraft(runtimeType, existing) : runtimeCreationDefaults(runtimeType),
      reservedNames: new Set(otherRuntimes.map((runtime) => runtimeInstanceName(runtime).toLocaleLowerCase())),
    }
  })
  const runtimeId = React.useRef(initial.runtimeId)
  const [name, setName] = React.useState(initial.name)
  const [configuring, setConfiguring] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const validateName = (value: string) => {
    setName(value)
    if (initial.reservedNames.has(value.toLocaleLowerCase())) {
      const message = t("runtimeNameTaken")
      setError(message)
      throw new Error(message)
    }
    setError(null)
  }

  const add = async (value: string, config?: Record<string, unknown>) => {
    validateName(value)
    setSaving(true)
    try {
      const added = await quickAddRuntime({
        token,
        connectorId,
        runtimeType,
        runtimeId: runtimeId.current,
        name: value,
        config,
        onRuntimeUpdated: (runtime) => {
          runtimeId.current = runtime.runtimeId
          onRuntimeUpdated(runtime)
        },
      })
      toast.success(t("runtimeConfiguredAndStarted", { name: runtimeInstanceName(added) }))
      onOpenChange(false)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t("createRuntimeFailed")
      setError(message)
      toast.error(message)
      throw cause
    } finally {
      setSaving(false)
    }
  }

  if (configuring) {
    return (
      <RuntimeConfigDialog
        runtimeName={name}
        schema={runtimeType.schema}
        uiSchema={runtimeType.uiSchema}
        config={initial.config}
        defaults={runtimeType.defaults}
        requiredFields={initial.runtimeId === runtimeType.runtimeType ? [] : namedInstanceRequiredConfigFields(runtimeType)}
        saving={saving}
        submitLabel={t("configureAndStart")}
        open
        onOpenChange={(open) => { if (!saving && !open) setConfiguring(false) }}
        onSave={(config) => add(name, config)}
      />
    )
  }

  return (
    <RuntimeInstanceNameDialog
      open
      title={t("createRuntimeTitle", { type: runtimeType.displayName })}
      description={t("createRuntimeDescription", { type: runtimeType.displayName })}
      label={t("runtimeName")}
      requiredMessage={t("runtimeNameRequired")}
      placeholder={t("runtimeNamePlaceholder")}
      initialName={name}
      submitLabel={t("quickAddRuntime")}
      cancelLabel={tCommon("cancel")}
      saving={saving}
      errorMessage={error}
      notice={runtimeType.reason ? (
        <Alert><AlertDescription>{runtimeType.reason}</AlertDescription></Alert>
      ) : null}
      secondaryAction={{
        label: t("configure"),
        onSubmit: async (value) => { validateName(value); setConfiguring(true) },
      }}
      onOpenChange={onOpenChange}
      onSubmit={(value) => add(value)}
    />
  )
}
