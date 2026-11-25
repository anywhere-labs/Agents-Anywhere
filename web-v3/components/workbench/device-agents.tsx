"use client"

// The agents of a device (a section of its page). The ones that can be used come first, by name: a switch, start or
// stop, settings. The ones the Connector knows that are not installed are apart from them, folded into one line until
// it is opened (or nothing is installed yet): each opens its install dialog, and one being installed stays in sight.
// "+" adds an agent of one's own.
import { useState } from "react"
import { ChevronRightIcon, LoaderCircleIcon, PlayIcon, PlusIcon, RefreshCwIcon, SettingsIcon, SquareIcon } from "lucide-react"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { AddAgentDialog } from "@/components/workbench/add-agent-dialog"
import { AgentIcon } from "@/components/workbench/agent-icon"
import { AgentInstallDialog } from "@/components/workbench/agent-install-dialog"
import { useAgentProcesses } from "@/components/workbench/agent-processes"
import { AgentSettingsDialog } from "@/components/workbench/agent-settings-dialog"
import { SectionLabel } from "@/components/workbench/section-label"
import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import type { AgentEntry, DeviceRecord } from "@/lib/types/v3"
import { cn } from "@/lib/utils"
import { isInstalling, splitAgents, type ListedAgent } from "@/lib/workbench/agents"
import type { DeviceAgentsState } from "@/lib/workbench/use-device-agents"

type TunnelDevice = Pick<DeviceRecord, "id" | "mode_hint" | "presence">

/** Marks shown on the folded line, as a glimpse of what is in it. */
const PREVIEW_ICONS = 10

export function DeviceAgents({
  tunnelManager,
  device,
  online,
  state,
  agents,
  loading,
  refreshing,
  onRefresh,
  onOpenTerminal,
}: {
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  online: boolean
  state: DeviceAgentsState
  /** The device's agents with what the page knows of them, in any order. */
  agents: ListedAgent[]
  loading: boolean
  refreshing: boolean
  onRefresh: () => void
  onOpenTerminal: () => void
}) {
  const { t } = useI18n()
  const [unfolded, setUnfolded] = useState<boolean | null>(null)
  const [settings, setSettings] = useState<{ id: string; name: string; check?: boolean } | null>(null)
  const [installId, setInstallId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const processes = useAgentProcesses({ tunnelManager, device, onChanged: () => void state.load() })

  const { usable, more } = splitAgents(agents)
  const open = unfolded ?? usable.length === 0
  const shownMore = open ? more : more.filter((a) => isInstalling(a.entry?.install?.job))

  const toggle = async (id: string, enabled: boolean) => {
    if (!tunnelManager || !device) return
    try {
      state.put(await tunnelManager.updateAgent(device, { id, enabled }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section>
      <SectionLabel
        action={
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="xs"
              disabled={refreshing || !online}
              onClick={onRefresh}
              className="text-muted-foreground"
            >
              <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
              {t("common.refresh")}
            </Button>
            {state.managed && (
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!online}
                onClick={() => setAdding(true)}
                aria-label={t("addAgent.title")}
                title={t("addAgent.title")}
                className="text-muted-foreground hover:text-foreground"
              >
                <PlusIcon className="size-4" />
              </Button>
            )}
          </div>
        }
      >
        {t("device.agents")}
      </SectionLabel>

      {!online ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">{t("newConv.offline")}</p>
      ) : loading ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">{t("newConv.loadingAgents")}</p>
      ) : usable.length === 0 ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">{more.length > 0 ? t("device.noInstalledAgents") : t("newConv.noAgents")}</p>
      ) : (
        <ul className="flex flex-col">
          {usable.map((a) => (
            <UsableAgent
              key={a.id}
              agent={a}
              online={online}
              pending={processes.pending(a.id)}
              onOpen={() => (a.entry?.missing ? setInstallId(a.id) : setSettings({ id: a.id, name: a.name }))}
              onSettings={() => setSettings({ id: a.id, name: a.name })}
              onStart={() => processes.start({ id: a.id, name: a.name })}
              onStop={() => processes.stop({ id: a.id, name: a.name })}
              onToggle={(enabled) => void toggle(a.id, enabled)}
            />
          ))}
        </ul>
      )}

      {online && !loading && more.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setUnfolded(!open)}
            className="flex min-h-10 w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-muted-foreground transition-colors hover:bg-surface-hover"
          >
            <span className="flex size-5 shrink-0 items-center justify-center">
              <ChevronRightIcon className={cn("size-4 transition-transform", open && "rotate-90")} />
            </span>
            <span className="shrink-0 text-sm">{t("device.agentsNotInstalled", { count: more.length })}</span>
            {!open && (
              <span className="ml-auto flex h-4 min-w-0 flex-wrap items-center justify-end gap-x-3 overflow-hidden">
                {more.slice(0, PREVIEW_ICONS).map((a) => (
                  <AgentIcon key={a.id} agent={a.id} name={a.name} className="size-4" />
                ))}
              </span>
            )}
          </button>
          {shownMore.length > 0 && (
            <ul className="mt-1 grid gap-2 sm:grid-cols-2">
              {shownMore.map((a) => (
                <li key={a.id}>
                  <InstallableAgent agent={a} onOpen={() => setInstallId(a.id)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {settings && (
        <AgentSettingsDialog
          open
          onOpenChange={(next) => {
            if (!next) setSettings(null)
          }}
          tunnelManager={tunnelManager}
          device={device}
          agent={settings}
          entry={state.entryOf(settings.id)}
          managed={state.managed}
          checkNow={settings.check}
          onEntry={state.put}
          onStopped={() => void state.load()}
          onRemoved={() => {
            state.drop(settings.id)
            setSettings(null)
          }}
        />
      )}
      <AgentInstallDialog
        open={installId !== null}
        onOpenChange={(next) => {
          if (!next) setInstallId(null)
        }}
        tunnelManager={tunnelManager}
        device={device}
        entry={installId ? state.entryOf(installId) : null}
        onEntry={state.put}
        onSearch={state.search}
        onOpenTerminal={() => {
          setInstallId(null)
          onOpenTerminal()
        }}
      />
      <AddAgentDialog
        open={adding}
        onOpenChange={setAdding}
        tunnelManager={tunnelManager}
        device={device}
        onAdded={(entry: AgentEntry) => {
          state.put(entry)
          setAdding(false)
          setSettings({ id: entry.id, name: entry.name, check: true })
        }}
      />
      {processes.dialogs}
    </section>
  )
}

/** An agent that is there: start or stop, settings, and its switch. */
function UsableAgent({
  agent: a,
  online,
  pending,
  onOpen,
  onSettings,
  onStart,
  onStop,
  onToggle,
}: {
  agent: ListedAgent
  online: boolean
  pending: "starting" | "stopping" | null
  onOpen: () => void
  onSettings: () => void
  onStart: () => void
  onStop: () => void
  onToggle: (enabled: boolean) => void
}) {
  const { t } = useI18n()
  const { entry } = a
  const meta = [
    ...(entry?.missing
      ? [t("device.agentMissing", { program: entry.missing })]
      : !a.installed
        ? [t("device.agentNotFound", { command: entry?.command ?? "" })]
        : []),
    ...(a.count > 0 ? [t("device.agentConversations", { count: a.count })] : []),
    ...(a.running ? [t("device.agentRunning")] : []),
    ...(!a.enabled ? [t("device.agentOff")] : []),
    ...(entry?.custom ? [t("agent.custom")] : []),
    ...(entry?.gateway?.base_url ? [t("gateway.title")] : []),
    ...(entry?.customized ? [t("agent.customized")] : []),
  ].join(" · ")
  const stopping = pending === "stopping"

  return (
    <li className="group flex min-h-12 items-center gap-1 rounded-lg pr-2 transition-colors hover:bg-surface-hover">
      <button
        type="button"
        onClick={onOpen}
        className={cn("flex min-w-0 flex-1 items-center gap-3 rounded-lg py-2 pl-2 text-left", (!a.enabled || !a.installed) && "opacity-60")}
      >
        <AgentIcon agent={a.id} name={a.name} className="size-5 text-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{a.name}</span>
          {meta && <span className="block truncate text-xs text-muted-foreground">{meta}</span>}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
        {entry && a.installed && (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!online || pending !== null || (!a.running && !entry.enabled)}
            onClick={a.running || stopping ? onStop : onStart}
            aria-label={t(a.running || stopping ? "agent.stopTitle" : "agent.startTitle", { agent: a.name })}
            title={t(a.running || stopping ? "agent.stopTitle" : "agent.startTitle", { agent: a.name })}
            className="text-muted-foreground hover:text-foreground"
          >
            {pending ? (
              <LoaderCircleIcon className="size-4 animate-spin" />
            ) : a.running ? (
              <SquareIcon className="size-3.5" />
            ) : (
              <PlayIcon className="size-4" />
            )}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onSettings}
          aria-label={t("device.agentSettings", { agent: a.name })}
          title={t("device.agentSettings", { agent: a.name })}
          className="text-muted-foreground hover:text-foreground"
        >
          <SettingsIcon className="size-4" />
        </Button>
      </div>
      {entry && (
        <Switch
          checked={entry.enabled && a.installed}
          disabled={!online || !a.installed}
          onCheckedChange={(v) => onToggle(Boolean(v))}
          aria-label={`${t("agent.enabled")} · ${a.name}`}
          className="ml-1 shrink-0"
        />
      )}
    </li>
  )
}

/** An agent that can be installed. */
function InstallableAgent({ agent: a, onOpen }: { agent: ListedAgent; onOpen: () => void }) {
  const { t } = useI18n()
  const job = a.entry?.install?.job
  const busy = isInstalling(job)
  const meta = [
    ...(job?.state === "failed" ? [t("device.agentInstallFailed")] : []),
    ...(a.count > 0 ? [t("device.agentConversations", { count: a.count })] : []),
  ].join(" · ")
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("install.title", { agent: a.name })}
      className="flex min-h-12 w-full min-w-0 items-center gap-3 rounded-xl bg-card px-3 py-2 text-left transition-colors hover:bg-surface-hover"
    >
      <AgentIcon agent={a.id} name={a.name} className="size-5 text-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{a.name}</span>
        {meta && <span className="block truncate text-xs text-muted-foreground">{meta}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        {busy && <LoaderCircleIcon className="size-3.5 animate-spin" />}
        {busy ? t("install.running") : t("device.agentInstall")}
      </span>
    </button>
  )
}
