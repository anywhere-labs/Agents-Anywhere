"use client"

import Link from "next/link"
import { useState } from "react"
import {
  KeyRoundIcon,
  LaptopIcon,
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  SparklesIcon,
} from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AssistantPanel } from "@/components/workbench/assistant-panel"
import { E2eeLockBadge } from "@/components/workbench/e2ee-lock-badge"
import { PairDeviceDialog } from "@/components/workbench/pair-device-dialog"
import { RegisterDeviceDialog } from "@/components/workbench/register-device-dialog"
import { WorkbenchShell } from "@/components/workbench/workbench-shell"
import { useAssistant } from "@/lib/state/assistant-context"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { DevicePlatform } from "@/lib/types/v3"
import { cn } from "@/lib/utils"

const PLATFORM_ICON: Record<DevicePlatform, typeof LaptopIcon> = {
  macos: LaptopIcon,
  linux: ServerIcon,
  windows: MonitorIcon,
}

function DeviceFirstHome() {
  const { t } = useI18n()
  const {
    activeAccount,
    devices,
    deviceTrusts,
    mergeState,
    sessions,
    meshConnected,
    meshError,
    refreshDevices,
  } = useWorkbench()
  const { setDrawerOpen } = useAssistant()

  const [registerOpen, setRegisterOpen] = useState(false)
  const [pairOpen, setPairOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await refreshDevices()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 md:px-10">
      <div className="mx-auto max-w-4xl space-y-8">
        {/* Hero */}
        <header className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight">
                {activeAccount?.user.display_name || activeAccount?.user.email}
              </h1>
              <p className="text-sm text-muted-foreground">{t("sessions.selectPrompt")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void handleRefresh()} disabled={refreshing}>
                <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
                <span>{t("common.refresh")}</span>
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPairOpen(true)}>
                <KeyRoundIcon className="size-3.5" />
                <span>{t("devices.pair")}</span>
              </Button>
              <Button variant="outline" size="sm" onClick={() => setRegisterOpen(true)}>
                <PlusIcon className="size-3.5" />
                <span>{t("devices.register")}</span>
              </Button>
              <Button size="sm" onClick={() => setDrawerOpen(true)}>
                <SparklesIcon className="size-3.5" />
                <span>{t("shell.quickAssistant")}</span>
              </Button>
            </div>
          </div>

          {meshError && !meshConnected && (
            <div className="rounded-2xl bg-card px-4 py-3 text-xs text-muted-foreground">
              MeshCall Router: {meshError}
            </div>
          )}
        </header>

        {/* Devices Grid */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-foreground-secondary">{t("devices.title")}</h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              {devices.filter((d) => d.presence === "online").length} / {devices.length}{" "}
              {t("devices.online")}
            </span>
          </div>

          {devices.length === 0 ? (
            <div className="rounded-card bg-card p-8 text-center space-y-3">
              <LaptopIcon className="mx-auto size-7 stroke-[1.5] text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t("devices.empty")}</p>
              <Button variant="outline" size="sm" onClick={() => setRegisterOpen(true)}>
                {t("devices.register")}
              </Button>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {devices.map((dev) => {
                const Icon = PLATFORM_ICON[dev.platform] ?? LaptopIcon
                const trust = deviceTrusts[dev.id]
                const isEnc = dev.mode_hint === "encrypted" || Boolean(trust)
                const slice = mergeState.byDevice[dev.id]
                return (
                  <Link
                    key={dev.id}
                    href={`/devices/${encodeURIComponent(dev.id)}`}
                    className="group rounded-card bg-card p-5 transition-colors hover:bg-surface-raised"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <Icon className="size-5 shrink-0 stroke-[1.5] text-muted-foreground" />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-foreground">
                            {dev.name}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {dev.platform} · v{dev.connector_version}
                          </div>
                        </div>
                      </div>
                      <Badge variant={dev.presence === "online" ? "secondary" : "outline"}>
                        <span
                          className={cn(
                            "mr-1.5 inline-block size-1.5 rounded-full",
                            dev.presence === "online" ? "bg-success" : "bg-muted-foreground/40"
                          )}
                        />
                        {dev.presence === "online" ? t("devices.online") : t("devices.offline")}
                      </Badge>
                    </div>
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <div className="flex items-center gap-2">
                        {isEnc ? (
                          <E2eeLockBadge paired={Boolean(trust)} />
                        ) : (
                          <span>{t("devices.modeNormal")}</span>
                        )}
                      </div>
                      <span className="tabular-nums">
                        {slice?.sessions.length ?? dev.summary?.active_sessions ?? 0}{" "}
                        {t("shell.navSessions")}
                      </span>
                    </div>
                    {slice?.error_code === "e2e_required_locally" && (
                      <p className="mt-2 text-xs text-destructive">
                        {t("devices.locallyLockedError")}
                      </p>
                    )}
                  </Link>
                )
              })}
            </div>
          )}
        </section>

        {/* Aggregated Sessions List */}
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-foreground-secondary">{t("shell.navSessions")}</h2>
          {sessions.length === 0 ? (
            <div className="rounded-card bg-card p-8 text-center text-sm text-muted-foreground">
              {t("sessions.empty")}
            </div>
          ) : (
            <div className="divide-y divide-border rounded-card bg-card px-5">
              {sessions.slice(0, 15).map((s) => {
                const dev = devices.find((d) => d.id === s.device_id)
                const isEnc = dev?.mode_hint === "encrypted" || Boolean(deviceTrusts[s.device_id])
                const stale = mergeState.byDevice[s.device_id]?.stale
                return (
                  <Link
                    key={`${s.device_id}:${s.id}`}
                    href={`/sessions/${encodeURIComponent(s.device_id)}/${encodeURIComponent(s.id)}`}
                    className="flex items-center justify-between gap-4 py-3.5 transition-opacity hover:opacity-80"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {s.title || s.id}
                        </span>
                        {isEnc && <E2eeLockBadge paired={Boolean(deviceTrusts[s.device_id])} compact />}
                        {stale && (
                          <Badge variant="outline" className="text-[11px]">
                            {t("devices.offline")}
                          </Badge>
                        )}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {s.agent} · {dev?.name ?? s.device_id} · {s.cwd}
                      </div>
                    </div>
                    <Badge variant={s.state === "error" ? "destructive" : "secondary"}>
                      {s.state}
                    </Badge>
                  </Link>
                )
              })}
            </div>
          )}
        </section>
      </div>

      <RegisterDeviceDialog open={registerOpen} onOpenChange={setRegisterOpen} />
      <PairDeviceDialog open={pairOpen} onOpenChange={setPairOpen} />
    </div>
  )
}

function HomeContent() {
  const { preferences } = useWorkbench()
  if (preferences.assistantPrimary) {
    return <AssistantPanel />
  }
  return <DeviceFirstHome />
}

export default function HomePage() {
  return (
    <WorkbenchShell>
      <HomeContent />
    </WorkbenchShell>
  )
}
