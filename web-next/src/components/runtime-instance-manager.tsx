"use client"

import * as React from "react"
import {
  Check,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { LoadingState } from "@/components/loading-state"
import { RuntimeConfigDialog } from "@/components/runtime-config-dialog"
import { RuntimeErrorBadge } from "@/components/runtime-error-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { dashboardApi } from "@/features/dashboard/api"
import {
  availableRuntimeTypes,
  findCreatedRuntime,
  nextRuntimeInstanceName,
  recommendedRuntimeTypes,
} from "@/features/dashboard/runtime-instances"
import type {
  DeviceRuntimeStatus,
  DeviceRuntimeView,
  RuntimeTypeView,
} from "@/features/dashboard/types"
import { cn } from "@/lib/utils"

const RUNTIME_STATUS_LABEL_KEYS = {
  stopped: "runtimeStatus.stopped",
  discovering: "runtimeStatus.discovering",
  available: "runtimeStatus.available",
  unavailable: "runtimeStatus.unavailable",
  validating: "runtimeStatus.validating",
  starting: "runtimeStatus.starting",
  running: "runtimeStatus.running",
  stopping: "runtimeStatus.stopping",
  error: "runtimeStatus.error",
  unknown: "runtimeStatus.unknown",
} as const satisfies Record<DeviceRuntimeStatus, string>

type AddRuntimeDraft = {
  runtimeType: string
  name: string
  active: boolean
}

export function RuntimeInstanceManager({
  accessToken,
  connectorId,
  connectorOnline,
  discoverOnMount = false,
  className,
  onInstancesChanged,
}: {
  accessToken: string
  connectorId: string
  connectorOnline: boolean
  discoverOnMount?: boolean
  className?: string
  onInstancesChanged?: () => void
}) {
  const t = useTranslations("dashboard.device")
  const [runtimeTypes, setRuntimeTypes] = React.useState<RuntimeTypeView[]>([])
  const [runtimes, setRuntimes] = React.useState<DeviceRuntimeView[]>([])
  const [loading, setLoading] = React.useState(true)
  const [discovering, setDiscovering] = React.useState(false)
  const [busyRuntimeId, setBusyRuntimeId] = React.useState<string | null>(null)
  const [addDraft, setAddDraft] = React.useState<AddRuntimeDraft | null>(null)
  const [configRuntime, setConfigRuntime] = React.useState<DeviceRuntimeView | null>(null)
  const [renamingRuntimeId, setRenamingRuntimeId] = React.useState<string | null>(null)
  const [renameDraft, setRenameDraft] = React.useState("")
  const initializedConnectorRef = React.useRef<string | null>(null)

  const fetchRuntimeData = React.useCallback(async () => {
    const [runtimeTypesResponse, runtimesResponse] = await Promise.all([
      dashboardApi.getConnectorRuntimeTypes(accessToken, connectorId),
      dashboardApi.getConnectorRuntimes(accessToken, connectorId),
    ])
    setRuntimeTypes(runtimeTypesResponse.runtimeTypes)
    setRuntimes(runtimesResponse.runtimes)
    return runtimesResponse.runtimes
  }, [accessToken, connectorId])

  const loadRuntimeData = React.useCallback(async (discover: boolean) => {
    if (discover) setDiscovering(true)
    else setLoading(true)
    try {
      if (discover) {
        try {
          await dashboardApi.discoverConnectorRuntimeTypes(accessToken, connectorId)
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("discoverRuntimesFailed"))
        }
      }
      await fetchRuntimeData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("loadRuntimesFailed"))
    } finally {
      setLoading(false)
      setDiscovering(false)
    }
  }, [accessToken, connectorId, fetchRuntimeData, t])

  React.useEffect(() => {
    if (initializedConnectorRef.current === connectorId) return
    initializedConnectorRef.current = connectorId
    setRuntimeTypes([])
    setRuntimes([])
    setAddDraft(null)
    setConfigRuntime(null)
    setRenamingRuntimeId(null)
    void loadRuntimeData(discoverOnMount)
  }, [connectorId, discoverOnMount, loadRuntimeData])

  const availableTypes = React.useMemo(
    () => availableRuntimeTypes(runtimeTypes),
    [runtimeTypes],
  )
  const recommendedTypes = React.useMemo(
    () => recommendedRuntimeTypes(runtimeTypes),
    [runtimeTypes],
  )
  const sortedRuntimes = React.useMemo(
    () => [...runtimes].sort((left, right) => {
      const nameOrder = left.name.localeCompare(right.name)
      return nameOrder || left.runtimeId.localeCompare(right.runtimeId)
    }),
    [runtimes],
  )
  const addRuntimeType = addDraft
    ? availableTypes.find((runtimeType) => runtimeType.runtimeType === addDraft.runtimeType) ?? null
    : null

  const replaceRuntime = (runtime: DeviceRuntimeView) => {
    setRuntimes((current) => current.some((item) => item.runtimeId === runtime.runtimeId)
      ? current.map((item) => item.runtimeId === runtime.runtimeId ? runtime : item)
      : [...current, runtime])
    setConfigRuntime((current) => current?.runtimeId === runtime.runtimeId ? runtime : current)
  }

  const openAddRuntime = (runtimeType: RuntimeTypeView) => {
    setConfigRuntime(null)
    setAddDraft({
      runtimeType: runtimeType.runtimeType,
      name: nextRuntimeInstanceName(runtimeType.displayName, runtimes),
      active: true,
    })
  }

  const createRuntime = async (config: Record<string, unknown>) => {
    if (!addDraft || !addRuntimeType) return
    const beforeRuntimeIds = new Set(runtimes.map((runtime) => runtime.runtimeId))
    const requestedName = addDraft.name.trim()
    setBusyRuntimeId("new")
    try {
      const runtime = await dashboardApi.createConnectorRuntime(accessToken, connectorId, {
        runtimeType: addDraft.runtimeType,
        name: requestedName,
        config,
        active: addDraft.active,
      })
      replaceRuntime(runtime)
      toast.success(addDraft.active
        ? t("runtimeAddedAndStarted", { name: runtime.name })
        : t("runtimeAdded", { name: runtime.name }))
      onInstancesChanged?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("addRuntimeFailed"))
      try {
        const refreshed = await fetchRuntimeData()
        const failedRuntime = findCreatedRuntime(
          beforeRuntimeIds,
          refreshed,
          addDraft.runtimeType,
          requestedName,
        )
        if (failedRuntime) {
          setAddDraft(null)
          setConfigRuntime(failedRuntime)
        }
      } catch {
        // Keep the original failure as the primary user-facing error.
      }
      throw error
    } finally {
      setBusyRuntimeId(null)
    }
  }

  const saveRuntimeConfig = async (
    runtime: DeviceRuntimeView,
    config: Record<string, unknown>,
  ) => {
    setBusyRuntimeId(runtime.runtimeId)
    try {
      const updated = await dashboardApi.putConnectorRuntimeConfig(
        accessToken,
        connectorId,
        runtime.runtimeId,
        config,
      )
      replaceRuntime(updated)
      toast.success(t("runtimeConfigSaved", { name: runtime.name }))
      onInstancesChanged?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("saveRuntimeConfigFailed"))
      try {
        const refreshed = await fetchRuntimeData()
        const failedRuntime = refreshed.find((item) => item.runtimeId === runtime.runtimeId)
        if (failedRuntime) setConfigRuntime(failedRuntime)
      } catch {
        // Keep the original failure as the primary user-facing error.
      }
      throw error
    } finally {
      setBusyRuntimeId(null)
    }
  }

  const toggleRuntime = async (runtime: DeviceRuntimeView, active: boolean) => {
    setBusyRuntimeId(runtime.runtimeId)
    try {
      const updated = await dashboardApi.setConnectorRuntimeActive(
        accessToken,
        connectorId,
        runtime.runtimeId,
        active,
      )
      replaceRuntime(updated)
      onInstancesChanged?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("runtimeActionFailed"))
      try {
        await fetchRuntimeData()
      } catch {
        // Keep the original failure as the primary user-facing error.
      }
    } finally {
      setBusyRuntimeId(null)
    }
  }

  const startRename = (runtime: DeviceRuntimeView) => {
    setRenamingRuntimeId(runtime.runtimeId)
    setRenameDraft(runtime.name)
  }

  const submitRename = async (runtime: DeviceRuntimeView) => {
    const nextName = renameDraft.trim()
    if (!nextName) {
      toast.error(t("runtimeInstanceNameRequired"))
      return
    }
    if (nextName === runtime.name) {
      setRenamingRuntimeId(null)
      return
    }
    setBusyRuntimeId(runtime.runtimeId)
    try {
      const updated = await dashboardApi.renameConnectorRuntime(
        accessToken,
        connectorId,
        runtime.runtimeId,
        nextName,
      )
      replaceRuntime(updated)
      setRenamingRuntimeId(null)
      toast.success(t("runtimeRenamed", { name: updated.name }))
      onInstancesChanged?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("runtimeRenameFailed"))
      try {
        const refreshed = await fetchRuntimeData()
        const current = refreshed.find((item) => item.runtimeId === runtime.runtimeId)
        if (current?.name === nextName) setRenamingRuntimeId(null)
      } catch {
        // Keep the original failure as the primary user-facing error.
      }
    } finally {
      setBusyRuntimeId(null)
    }
  }

  if (loading) return <LoadingState className={cn("min-h-36", className)} />

  return (
    <>
      <div className={cn("flex flex-col gap-5", className)}>
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">{t("addedRuntimeInstances")}</h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadRuntimeData(true)}
              disabled={!connectorOnline || discovering}
            >
              <RefreshCw data-icon="inline-start" className={cn(discovering && "animate-spin")} />
              {discovering ? t("discoveringRuntimes") : t("refreshRuntimes")}
            </Button>
          </div>

          {sortedRuntimes.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">{t("noRuntimeInstances")}</p>
          ) : (
            <div className="flex flex-col gap-1">
              {sortedRuntimes.map((runtime) => {
                const busy = busyRuntimeId === runtime.runtimeId
                const renaming = renamingRuntimeId === runtime.runtimeId
                return (
                  <div
                    key={runtime.runtimeId}
                    className="flex min-h-14 flex-wrap items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent/30"
                  >
                    {busy ? (
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <span className={cn("size-2 shrink-0 rounded-full", runtimeStatusDot(runtime))} />
                    )}
                    <div className="min-w-0 flex-[1_1_12rem]">
                      {renaming ? (
                        <div className="flex items-center gap-1.5">
                          <Input
                            value={renameDraft}
                            onChange={(event) => setRenameDraft(event.currentTarget.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") void submitRename(runtime)
                              if (event.key === "Escape") setRenamingRuntimeId(null)
                            }}
                            maxLength={128}
                            className="h-8"
                            aria-label={t("runtimeInstanceName")}
                            autoFocus
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => void submitRename(runtime)}
                            disabled={busy}
                            aria-label={t("saveRuntimeName")}
                          >
                            <Check />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setRenamingRuntimeId(null)}
                            disabled={busy}
                            aria-label={t("cancelRuntimeRename")}
                          >
                            <X />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium">{runtime.name}</span>
                          <Badge variant="outline" className="shrink-0 font-normal">
                            {t(RUNTIME_STATUS_LABEL_KEYS[runtime.status])}
                          </Badge>
                          <RuntimeErrorBadge error={runtime.error} />
                        </div>
                      )}
                      {!renaming ? (
                        <p className="truncate text-xs text-muted-foreground">
                          {runtime.typeDisplayName}
                          {!runtime.available ? ` · ${t("runtimeTypeUnavailable")}` : ""}
                        </p>
                      ) : null}
                    </div>
                    {!renaming ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => startRename(runtime)}
                          disabled={busy}
                          aria-label={t("renameRuntime", { name: runtime.name })}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => setConfigRuntime(runtime)}
                          disabled={busy}
                          aria-label={t("configureRuntime", { name: runtime.name })}
                        >
                          <Settings />
                        </Button>
                        <Switch
                          checked={runtime.active}
                          onCheckedChange={(active) => void toggleRuntime(runtime, active)}
                          disabled={busy || (!runtime.active && (!connectorOnline || !runtime.available || !runtime.configured))}
                          aria-label={runtime.active
                            ? t("deactivateRuntime", { name: runtime.name })
                            : t("activateRuntime", { name: runtime.name })}
                        />
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <Separator />

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-medium">{t("recommendedRuntimeTypes")}</h3>
              <p className="text-xs text-muted-foreground">{t("recommendedRuntimeTypesDescription")}</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => availableTypes[0] && openAddRuntime(availableTypes[0])}
              disabled={!connectorOnline || availableTypes.length === 0}
            >
              <Plus data-icon="inline-start" />
              {t("addCustomRuntime")}
            </Button>
          </div>

          {recommendedTypes.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">{t("noRecommendedRuntimeTypes")}</p>
          ) : (
            <div className="flex flex-col gap-1">
              {recommendedTypes.map((runtimeType) => (
                <div
                  key={runtimeType.runtimeType}
                  className="flex min-h-14 flex-wrap items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent/30"
                >
                  <div className="min-w-0 flex-[1_1_12rem]">
                    <p className="truncate text-sm font-medium">{runtimeType.displayName}</p>
                    {runtimeType.description ? (
                      <p className="line-clamp-2 text-xs text-muted-foreground">{runtimeType.description}</p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => openAddRuntime(runtimeType)}
                    disabled={!connectorOnline}
                  >
                    <Plus data-icon="inline-start" />
                    {t("addRuntime")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {addDraft && addRuntimeType ? (
        <RuntimeConfigDialog
          formKey={`new:${addRuntimeType.runtimeType}`}
          runtimeName={addRuntimeType.displayName}
          title={t("addRuntimeTitle")}
          description={t("addRuntimeDescription")}
          schema={addRuntimeType.schema}
          uiSchema={addRuntimeType.uiSchema}
          defaults={addRuntimeType.defaults}
          config={null}
          instanceFields={{
            runtimeType: addDraft.runtimeType,
            runtimeTypes: availableTypes.map((runtimeType) => ({
              value: runtimeType.runtimeType,
              label: runtimeType.displayName,
            })),
            name: addDraft.name,
            startImmediately: addDraft.active,
            onRuntimeTypeChange: (runtimeType) => {
              const selected = availableTypes.find((item) => item.runtimeType === runtimeType)
              if (!selected) return
              setAddDraft({
                runtimeType,
                name: nextRuntimeInstanceName(selected.displayName, runtimes),
                active: addDraft.active,
              })
            },
            onNameChange: (name) => setAddDraft((current) => current ? { ...current, name } : current),
            onStartImmediatelyChange: (active) => setAddDraft((current) => current ? { ...current, active } : current),
          }}
          saving={busyRuntimeId === "new"}
          submitLabel={addDraft.active ? t("addAndStartRuntime") : t("addRuntime")}
          open
          onOpenChange={(open) => { if (!open) setAddDraft(null) }}
          onSave={createRuntime}
        />
      ) : null}

      {configRuntime ? (
        <RuntimeConfigDialog
          formKey={configRuntime.runtimeId}
          runtimeName={configRuntime.name}
          schema={configRuntime.schema}
          uiSchema={configRuntime.uiSchema}
          defaults={configRuntime.defaults}
          config={configRuntime.config}
          saving={busyRuntimeId === configRuntime.runtimeId}
          open
          onOpenChange={(open) => { if (!open) setConfigRuntime(null) }}
          onSave={(config) => saveRuntimeConfig(configRuntime, config)}
        />
      ) : null}
    </>
  )
}

function runtimeStatusDot(runtime: DeviceRuntimeView) {
  if (runtime.status === "running") return "bg-emerald-500"
  if (runtime.status === "error") return "bg-destructive"
  if (runtime.status === "starting" || runtime.status === "stopping") return "bg-blue-500"
  if (runtime.active) return "bg-amber-500"
  return "bg-muted-foreground/40"
}
