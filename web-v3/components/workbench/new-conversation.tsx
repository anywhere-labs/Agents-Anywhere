"use client"

// New conversation (client-experience-proposal §2.6; v2 task-composer + use-session-creation): pick the device (online
// ones), the agent (what the device reports), and the working directory (home, the device's recent projects, or a
// folder browser) — the last choice is remembered — then write the first message. Once the agent and the directory
// are chosen the agent is started (aa.v3.Sessions/prepare), so its model, permission and thinking options sit in the
// composer before anything is sent (starting with the ones last used with this agent). The conversation is created
// when the first message is sent (create takes the started agent over, with the options picked here), its attachments
// are uploaded into it, the message is sent, and the page moves into the conversation.
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect, useMemo, useState } from "react"
import {
  BotIcon,
  ChevronDownIcon,
  FolderIcon,
  LaptopIcon,
  LoaderCircleIcon,
  PlusIcon,
} from "lucide-react"
import { toast } from "sonner"

import { DropOverlay, useDraftAttachments, useDropZone, useTransferPorts } from "@/components/conversation/attachments"
import { Composer, writeDraft } from "@/components/conversation/composer"
import { useI18n } from "@/components/i18n-provider"
import { FullPageSpinner } from "@/components/spinner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { AgentIcon } from "@/components/workbench/agent-icon"
import { DirectoryOptions, FolderPickerDialog } from "@/components/workbench/folder-picker"
import { DeviceStatusIcon } from "@/components/workbench/device-status"
import { useWorkbenchUi } from "@/components/workbench/workbench-ui"
import { useWorkbench } from "@/lib/state/workbench-context"
import { useDevice, useDriveQuota } from "@/lib/workbench/device-info"
import { rememberStart, useLocalPrefs } from "@/lib/workbench/local-prefs"
import { changedPicks, usePreparedAgent, withPicks } from "@/lib/workbench/prepared-agent"
import { agentLabel, deviceProjects, projectName, sessionHref, tildePath } from "@/lib/workbench/tree"
import { titleFromMessage } from "@/lib/workbench/title"

const CHIP =
  "h-9 max-w-full min-w-0 gap-2 rounded-full border-border-strong bg-transparent px-3.5 text-sm font-normal"

function NewConversationInner() {
  const { t } = useI18n()
  const router = useRouter()
  const search = useSearchParams()
  const { activeAccount, devices, sessions, refreshSessions, meshConnected, meshError } = useWorkbench()
  const { openRegisterDevice } = useWorkbenchUi()
  const [prefs, setPrefs] = useLocalPrefs(activeAccount?.accountId)
  const last = prefs.lastStart

  // Device: ?device=, else the last one used (if still here and online), else the first online device.
  const [pickedDevice, setPickedDevice] = useState<string | null>(search.get("device"))
  const deviceId = useMemo(() => {
    const lastOnline = devices.some((d) => d.id === last?.deviceId && d.presence === "online") ? last?.deviceId : null
    const candidates = [pickedDevice, lastOnline, devices.find((d) => d.presence === "online")?.id, devices[0]?.id]
    return candidates.find((id) => id && devices.some((d) => d.id === id)) ?? null
  }, [devices, last?.deviceId, pickedDevice])
  const { device, tunnelDevice, encrypted, info, reload, tunnelManager } = useDevice(deviceId)
  const runtimes = useMemo(() => info.status?.runtimes ?? [], [info.status?.runtimes])

  // Agent: ?agent=, else the last one used on this device, else the device's first.
  const [pickedAgent, setPickedAgent] = useState<{ device: string | null; agent: string } | null>(() => {
    const a = search.get("agent")
    return a ? { device: search.get("device"), agent: a } : null
  })
  const agent = useMemo(() => {
    const ids = runtimes.map((r) => r.id)
    const candidates = [
      pickedAgent && (pickedAgent.device === null || pickedAgent.device === deviceId) ? pickedAgent.agent : null,
      deviceId ? last?.agentByDevice?.[deviceId] : null,
      ids[0],
    ]
    return candidates.find((a) => a && ids.includes(a)) ?? null
  }, [deviceId, last?.agentByDevice, pickedAgent, runtimes])

  // Directory: picked, else ?cwd=, else the last one used on this device; null = home.
  const [pickedCwd, setPickedCwd] = useState<{ device: string | null; cwd: string | null } | null>(() => {
    const c = search.get("cwd")
    return c ? { device: search.get("device"), cwd: c } : null
  })
  const cwd =
    pickedCwd && (pickedCwd.device === null || pickedCwd.device === deviceId)
      ? pickedCwd.cwd
      : deviceId
        ? (last?.cwdByDevice?.[deviceId] ?? null)
        : null
  const recent = useMemo(
    () => deviceProjects(sessions.filter((s) => s.device_id === deviceId)),
    [deviceId, sessions]
  )
  const [dirMenuOpen, setDirMenuOpen] = useState(false)
  const [browseOpen, setBrowseOpen] = useState(false)
  const [starting, setStarting] = useState(false)

  const quota = useDriveQuota()
  const ports = useTransferPorts(tunnelManager, tunnelDevice)
  const drafts = useDraftAttachments({
    ports,
    encrypted,
    rpcMaxBytes: info.settings?.max_rpc_file_bytes,
    quota,
  })

  const online = device?.presence === "online"
  const agentName = agent ? agentLabel(agent, runtimes) : "Agent"
  const loadingAgents = online && !info.status && !info.error
  const ready = Boolean(online && agent && tunnelManager && tunnelDevice)

  // The agent, started as soon as it and the directory are chosen; its options, with the picks made here (and,
  // for options not touched here, the ones last used with this agent on this device).
  const { state: prep, retry: retryPrepare } = usePreparedAgent({
    tunnelManager,
    device: tunnelDevice,
    agent,
    cwd,
    enabled: ready && !info.error,
  })
  const agentKey = deviceId && agent ? `${deviceId}:${agent}` : null
  const [picked, setPicked] = useState<{ key: string | null; values: Record<string, string> }>({ key: null, values: {} })
  const ownPicks = useMemo(() => (picked.key === agentKey ? picked.values : {}), [agentKey, picked])
  const picks = useMemo(
    () => ({ ...(agentKey ? prefs.configByAgent[agentKey] : undefined), ...ownPicks }),
    [agentKey, ownPicks, prefs.configByAgent]
  )
  const shownConfig = useMemo(
    () => (prep.status === "ready" ? withPicks(prep.prepared.config, picks) : []),
    [picks, prep]
  )
  // A first start downloads the agent: after a few seconds, say so.
  const startingKey = prep.status === "starting" ? `${agentKey}|${cwd ?? ""}` : null
  const [slowKey, setSlowKey] = useState<string | null>(null)
  useEffect(() => {
    if (!startingKey) return
    const timer = window.setTimeout(() => setSlowKey(startingKey), 4000)
    return () => window.clearTimeout(timer)
  }, [startingKey])
  const slowStart = startingKey !== null && slowKey === startingKey

  const drop = useDropZone((files) => drafts.add(files), Boolean(ready))

  // The conversation exists but its first message did not go: continue there, the text waiting in its composer.
  const handOver = (id: string, text: string) => {
    if (!deviceId) return false
    if (text) writeDraft(`${deviceId}:${id}`, text)
    void refreshSessions()
    router.push(sessionHref(deviceId, id))
    return true
  }

  const start = async (text: string): Promise<boolean> => {
    if (!tunnelManager || !tunnelDevice || !agent || !deviceId) return false
    setStarting(true)
    let created: string | null = null
    try {
      // Take the started agent over; still starting: wait for it (preparing again joins the start in progress).
      let prepared = prep.status === "ready" ? prep.prepared : null
      if (prep.status === "starting") {
        prepared = await tunnelManager.prepareSession(tunnelDevice, { agent, ...(cwd ? { cwd } : {}) }).catch(() => null)
      }
      // With a started agent only what differs from its options is sent; otherwise (a Connector without prepare,
      // or a start that failed) the options last used, as before.
      const config = prepared ? changedPicks(prepared.config, withPicks(prepared.config, picks)) : picks
      const title = titleFromMessage(text)
      const session = await tunnelManager.createSession(tunnelDevice, {
        agent,
        ...(title ? { title } : {}),
        ...(cwd ? { cwd } : {}),
        ...(prepared ? { prepared_id: prepared.prepared_id } : {}),
        ...(Object.keys(config).length ? { config } : {}),
      })
      created = session.id
      setPrefs((p) => ({
        lastStart: rememberStart(p.lastStart, deviceId, agent, cwd),
        // What was picked here is remembered for the next conversation with this agent on this device.
        ...(Object.keys(ownPicks).length
          ? { configByAgent: { ...p.configByAgent, [`${deviceId}:${agent}`]: { ...p.configByAgent[`${deviceId}:${agent}`], ...ownPicks } } }
          : {}),
      }))
      const refs = drafts.items.length ? await drafts.upload(session.id) : []
      if (refs === null) {
        // Its attachments did not all go: open it with the text kept, to add the files again there.
        toast.error(t("attach.blocked"))
        return handOver(session.id, text)
      }
      if (text || refs.length) {
        await tunnelManager.sendMessage(tunnelDevice, {
          id: session.id,
          client_msg_id: `msg_${crypto.randomUUID()}`,
          content: text || undefined,
          delivery: "auto",
          attachments: refs.length ? refs : undefined,
        })
      }
      drafts.clear()
      void refreshSessions()
      router.push(sessionHref(deviceId, session.id))
      return true
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      if (created) {
        toast.error(t("newConv.sendFailed", { error }))
        return handOver(created, text)
      }
      toast.error(t("newConv.failed", { error }))
      return false
    } finally {
      setStarting(false)
    }
  }

  if (devices.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-md space-y-4 text-center">
          <LaptopIcon className="mx-auto size-8 stroke-[1.5] text-muted-foreground" />
          <div className="space-y-1.5">
            <h1 className="font-heading text-xl font-semibold tracking-tight">{t("newConv.noDevices")}</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">{t("newConv.noDevicesHint")}</p>
          </div>
          <Button onClick={openRegisterDevice}>
            <PlusIcon className="size-4" />
            {t("devices.register")}
          </Button>
        </div>
      </div>
    )
  }

  let notice: string | null = null
  let onRetry: (() => void) | null = null
  if (meshError && !meshConnected) notice = `MeshCall Router: ${meshError}`
  else if (device && !online) notice = t("newConv.offline")
  else if (info.error) {
    notice = info.error.code === "e2e_not_paired" ? t("devices.unpairedHint") : info.error.message
    onRetry = () => void reload()
  } else if (loadingAgents) notice = t("newConv.loadingAgents")
  else if (online && info.status && runtimes.length === 0) notice = `${t("newConv.noAgents")} — ${t("newConv.noAgentsHint")}`
  else if (prep.status === "failed") {
    if (prep.reason === "agent_auth_required") {
      const methods = prep.authMethods.map((m) => m.name).join("、")
      notice = t("newConv.agentAuthRequired", { agent: agentName }) + (methods ? ` ${t("newConv.agentAuthMethods", { methods })}` : "")
    } else if (prep.reason === "invalid_cwd") notice = t("newConv.invalidCwd")
    else if (prep.reason === "unknown_agent") notice = t("newConv.unknownAgent", { agent: agentName })
    else notice = t("newConv.agentStartFailed", { agent: agentName, error: prep.message })
    onRetry = retryPrepare
  } else if (slowStart) notice = t("newConv.agentStarting", { agent: agentName })

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto" {...drop.handlers}>
      <DropOverlay show={drop.over} />
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-6 px-4 py-10 sm:px-6">
        <div className="space-y-1.5 text-center">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{t("newConv.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("newConv.subtitle")}</p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2">
          {/* Device */}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" className={CHIP} aria-label={t("newConv.device")} />}>
              {device ? (
                <DeviceStatusIcon device={device} />
              ) : (
                <LaptopIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{device?.name ?? t("newConv.chooseDevice")}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="w-72">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("newConv.device")}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={deviceId ?? ""} onValueChange={(v) => setPickedDevice(String(v))}>
                  {devices.map((d) => (
                    <DropdownMenuRadioItem key={d.id} value={d.id} disabled={d.presence !== "online"} closeOnClick>
                      <span className="min-w-0 flex-1 truncate">{d.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {d.presence === "online" ? t("devices.online") : t("devices.offline")}
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Agent */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" className={CHIP} disabled={!runtimes.length} aria-label={t("newConv.agent")} />
              }
            >
              {loadingAgents ? (
                <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-muted-foreground" />
              ) : agent ? (
                <AgentIcon agent={agent} name={agentName} />
              ) : (
                <BotIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{agent ? agentName : t("newConv.chooseAgent")}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="w-64">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("newConv.agent")}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={agent ?? ""}
                  onValueChange={(v) => setPickedAgent({ device: deviceId, agent: String(v) })}
                >
                  {runtimes.map((r) => (
                    <DropdownMenuRadioItem key={r.id} value={r.id} closeOnClick>
                      <AgentIcon agent={r.id} name={r.name} />
                      {agentLabel(r.id, runtimes)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Directory */}
          <Popover open={dirMenuOpen} onOpenChange={setDirMenuOpen}>
            <PopoverTrigger
              render={<Button variant="outline" className={CHIP} disabled={!online} aria-label={t("newConv.directory")} />}
            >
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate" title={cwd ?? "~"}>
                {cwd ? projectName(cwd) : t("newConv.homeDirectory")}
              </span>
              {cwd && <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">{tildePath(cwd)}</span>}
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
            </PopoverTrigger>
            <PopoverContent align="center" className="w-80 gap-0 p-1.5">
              <DirectoryOptions
                value={cwd}
                recent={recent}
                onPick={(c) => {
                  setPickedCwd({ device: deviceId, cwd: c })
                  setDirMenuOpen(false)
                }}
                onBrowse={() => {
                  setDirMenuOpen(false)
                  setBrowseOpen(true)
                }}
              />
            </PopoverContent>
          </Popover>
        </div>

        {notice && (
          <p className="text-center text-sm leading-relaxed text-muted-foreground">
            {notice}
            {onRetry && (
              <button type="button" onClick={onRetry} className="ml-2 font-medium text-foreground underline-offset-4 hover:underline">
                {t("wb.retry")}
              </button>
            )}
          </p>
        )}

        <Composer
          agent={agentName}
          config={shownConfig}
          configLoading={prep.status === "starting"}
          onConfig={(id, value) => setPicked({ key: agentKey, values: { ...ownPicks, [id]: value } })}
          disabled={!ready || starting}
          autoFocus
          placeholder={starting ? t("newConv.starting") : t("newConv.placeholder", { agent: agentName })}
          drafts={drafts}
          draftKey="new"
          onSubmit={(text) => start(text)}
        />
        {starting && (
          <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            {t("newConv.starting")}
          </p>
        )}
      </div>

      <FolderPickerDialog
        open={browseOpen}
        onOpenChange={setBrowseOpen}
        tunnelManager={tunnelManager}
        device={tunnelDevice}
        start={cwd ?? undefined}
        onPick={(path) => setPickedCwd({ device: deviceId, cwd: path })}
      />
    </div>
  )
}

/** Another `/new?device=…&agent=…` (⌘K, a device page) is a fresh launcher: its choices come from the link. */
function NewConversationFromLink() {
  const search = useSearchParams()
  return <NewConversationInner key={search.toString()} />
}

/** The launcher, with `useSearchParams` behind a Suspense boundary (static prerendering needs one). */
export function NewConversation() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <NewConversationFromLink />
    </Suspense>
  )
}
