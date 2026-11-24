"use client"

// An agent's settings on one device (from its row on the device page; v2's runtime settings): on or off (it keeps its
// product name: agents are not renamed), AA's approvals for agents that ask no one before they act (Pi: a Pi
// extension the device installs globally), whether its processes are running (stop them, or start it to check it can
// be used) and how long an idle one is kept, and how it is started (command, arguments, environment variables) with a
// way back to the Connector's defaults. Changes apply the next time the agent starts. A Connector that does not manage agents yet offers only the
// check. There is no "defaults for new conversations": the device starts each one with the settings the agent's
// newest conversation was created with.
import { useState } from "react"
import { DeadlineExceededError, MeshCallError } from "meshcall/web"
import { LoaderCircleIcon, PlusIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { ConfirmDialog } from "@/components/console/confirm-dialog"
import { DropdownSelect } from "@/components/dropdown-select"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { AgentIcon } from "@/components/workbench/agent-icon"
import { Card, Group, Row } from "@/components/workbench/settings-parts"
import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import type { AgentEntry, AgentUpdate, DeviceRecord } from "@/lib/types/v3"
import { joinArgs, splitArgs } from "@/lib/workbench/args"

type TunnelDevice = Pick<DeviceRecord, "id" | "mode_hint" | "presence">

type Check =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "ready" }
  | { status: "failed"; reason: string; message: string; methods: string[] }

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** How long an idle conversation's agent is kept, in minutes (0: never closed, the default). */
const IDLE_CLOSE_CHOICES = [0, 10, 30, 60, 180, 720]

export function AgentSettingsDialog({
  open,
  onOpenChange,
  tunnelManager,
  device,
  agent,
  entry,
  managed,
  onEntry,
  onStopped,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  /** The agent as the device lists it. */
  agent: { id: string; name: string }
  /** Its settings, when the Connector manages agents (null while loading or when it does not). */
  entry: AgentEntry | null
  managed: boolean
  onEntry: (entry: AgentEntry) => void
  onStopped: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(760px,calc(100dvh-4rem))] flex-col gap-0 p-0 sm:max-w-xl">
        {/* Remounted per agent and per opening, so the form starts from the agent's current settings. */}
        {open && (
          <AgentSettingsBody
            key={`${device?.id}:${agent.id}`}
            tunnelManager={tunnelManager}
            device={device}
            agent={agent}
            entry={entry}
            managed={managed}
            onEntry={onEntry}
            onStopped={onStopped}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function AgentSettingsBody({
  tunnelManager,
  device,
  agent,
  entry,
  managed,
  onEntry,
  onStopped,
}: {
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  agent: { id: string; name: string }
  entry: AgentEntry | null
  managed: boolean
  onEntry: (entry: AgentEntry) => void
  onStopped: () => void
}) {
  const { t } = useI18n()
  const online = device?.presence === "online"
  const name = entry?.name ?? agent.name

  // How it is started: edited here, saved together.
  const [form, setForm] = useState(() => ({
    command: entry?.command ?? "",
    args: entry ? joinArgs(entry.args) : "",
  }))
  const [envSet, setEnvSet] = useState<Record<string, string>>({})
  const [envRemoved, setEnvRemoved] = useState<string[]>([])
  const [newEnv, setNewEnv] = useState({ key: "", value: "" })
  const [saving, setSaving] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [check, setCheck] = useState<Check>({ status: "idle" })

  const dirty =
    entry !== null &&
    (form.command.trim() !== entry.command ||
      joinArgs(splitArgs(form.args)) !== joinArgs(entry.args) ||
      Object.keys(envSet).length > 0 ||
      envRemoved.length > 0)

  const update = async (patch: Omit<AgentUpdate, "id">) => {
    if (!tunnelManager || !device) return null
    try {
      const next = await tunnelManager.updateAgent(device, { id: agent.id, ...patch })
      onEntry(next)
      return next
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      return null
    }
  }

  const save = async () => {
    if (!entry) return
    const command = form.command.trim()
    if (!command) {
      toast.error(t("agent.commandRequired"))
      return
    }
    setSaving(true)
    const env: Record<string, string | null> = { ...envSet }
    for (const key of envRemoved) env[key] = null
    const next = await update({
      ...(command !== entry.command ? { command } : {}),
      ...(joinArgs(splitArgs(form.args)) !== joinArgs(entry.args) ? { args: splitArgs(form.args) } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    })
    setSaving(false)
    if (!next) return
    setForm({ command: next.command, args: joinArgs(next.args) })
    setEnvSet({})
    setEnvRemoved([])
    toast.success(next.running > 0 ? t("agent.savedRestart") : t("common.saved"))
  }

  const reset = async () => {
    setConfirmReset(false)
    const next = await update({ reset: true })
    if (!next) return
    setForm({ command: next.command, args: joinArgs(next.args) })
    setEnvSet({})
    setEnvRemoved([])
    toast.success(t("common.saved"))
  }

  const stop = async (force: boolean) => {
    if (!tunnelManager || !device) return
    setConfirmStop(false)
    setStopping(true)
    try {
      const res = await tunnelManager.stopAgent(device, agent.id, force)
      toast.success(t("agent.stopped", { count: res.stopped }))
      if (check.status === "ready") setCheck({ status: "idle" })
      onStopped()
    } catch (err) {
      if (err instanceof MeshCallError && err.reason === "turns_running") setConfirmStop(true)
      else toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setStopping(false)
    }
  }

  // Start it (the same warm start a new conversation uses): tells whether it can be used and what it offers.
  const runCheck = async () => {
    if (!tunnelManager || !device) return
    setCheck({ status: "starting" })
    for (;;) {
      try {
        await tunnelManager.prepareSession(device, { agent: agent.id })
        setCheck({ status: "ready" })
        onStopped()
        return
      } catch (err) {
        if (err instanceof DeadlineExceededError) continue
        const raw = err instanceof MeshCallError ? err.details?.auth_methods : undefined
        const methods = Array.isArray(raw)
          ? raw.flatMap((m) => (m && typeof m === "object" && typeof m.name === "string" ? [m.name as string] : []))
          : []
        setCheck({
          status: "failed",
          reason: err instanceof MeshCallError ? (err.reason ?? err.code) : "error",
          message: err instanceof Error ? err.message : String(err),
          methods,
        })
        return
      }
    }
  }

  const envKeys = [...new Set([...(entry?.env_keys ?? []), ...Object.keys(envSet)])].filter((k) => !envRemoved.includes(k))
  const addEnv = () => {
    const key = newEnv.key.trim()
    if (!ENV_NAME.test(key)) {
      toast.error(t("agent.envNameInvalid"))
      return
    }
    setEnvSet((e) => ({ ...e, [key]: newEnv.value }))
    setEnvRemoved((r) => r.filter((k) => k !== key))
    setNewEnv({ key: "", value: "" })
  }

  const idleLabel = (minutes: number) =>
    minutes === 0
      ? t("agent.idleNever")
      : minutes % 60 === 0
        ? t("agent.idleHours", { count: minutes / 60 })
        : t("agent.idleMinutes", { count: minutes })

  let checkText: string | null = null
  if (check.status === "failed") {
    checkText =
      check.reason === "agent_auth_required"
        ? t("newConv.agentAuthRequired", { agent: name }) + (check.methods.length ? ` ${t("newConv.agentAuthMethods", { methods: check.methods.join("、") })}` : "")
        : check.reason === "agent_disabled"
          ? t("agent.disabledHint")
          : t("newConv.agentStartFailed", { agent: name, error: check.message })
  }

  return (
    <>
      <DialogHeader className="flex-row items-center gap-3 border-b border-border px-6 py-4 text-left">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-card">
          <AgentIcon agent={agent.id} name={name} className="size-5" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <DialogTitle className="truncate">{name}</DialogTitle>
          <DialogDescription className="truncate">
            {entry ? (entry.builtin ? t("agent.builtin") : t("agent.custom")) : agent.id}
            {entry?.customized ? ` · ${t("agent.customized")}` : ""}
          </DialogDescription>
        </div>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
        {!managed && <p className="rounded-2xl bg-card px-4 py-3 text-sm text-muted-foreground">{t("agent.unmanaged")}</p>}

        {managed && (
          <Group>
            <Card>
              <Row label={t("agent.enabled")} hint={t("agent.enabledHint")}>
                <Switch
                  checked={entry?.enabled ?? true}
                  disabled={!entry || !online}
                  onCheckedChange={(v) => void update({ enabled: Boolean(v) })}
                  aria-label={t("agent.enabled")}
                />
              </Row>
              {entry?.approvals !== undefined && (
                <Row label={t("agent.approvals")} hint={t("agent.approvalsHint", { agent: name })}>
                  <Switch
                    checked={entry.approvals}
                    disabled={!online}
                    onCheckedChange={async (v) => {
                      const next = await update({ approvals: Boolean(v) })
                      if (next && next.running > 0) toast.success(t("agent.savedRestart"))
                    }}
                    aria-label={t("agent.approvals")}
                  />
                </Row>
              )}
            </Card>
          </Group>
        )}

        <Group title={t("agent.running")}>
          <Card>
            {managed && (
              <Row
                label={
                  !entry
                    ? t("common.loading")
                    : entry.running > 0
                      ? t("agent.runningCount", { count: entry.running })
                      : t("agent.notRunning")
                }
                hint={entry && entry.busy > 0 ? t("agent.busyCount", { count: entry.busy }) : t("agent.runningHint")}
              >
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!entry || entry.running === 0 || stopping || !online}
                  onClick={() => void stop(false)}
                >
                  {stopping && <LoaderCircleIcon className="size-3.5 animate-spin" />}
                  {t("agent.stop")}
                </Button>
              </Row>
            )}
            {managed && entry?.idle_close_minutes !== undefined && (
              <Row label={t("agent.idleClose")} hint={t("agent.idleCloseHint")}>
                <DropdownSelect
                  value={String(entry.idle_close_minutes)}
                  options={[...new Set([...IDLE_CLOSE_CHOICES, entry.idle_close_minutes])]
                    .sort((a, b) => a - b)
                    .map((minutes) => ({ value: String(minutes), label: idleLabel(minutes) }))}
                  onChange={(v) => void update({ idle_close_minutes: Number(v) })}
                  label={t("agent.idleClose")}
                  align="end"
                />
              </Row>
            )}
            <Row label={t("agent.check")} hint={checkText ?? (check.status === "ready" ? t("agent.checkOk") : t("agent.checkHint"))}>
              <Button variant="outline" size="sm" disabled={!online || check.status === "starting"} onClick={() => void runCheck()}>
                {check.status === "starting" && <LoaderCircleIcon className="size-3.5 animate-spin" />}
                {t("agent.start")}
              </Button>
            </Row>
          </Card>
        </Group>

        {managed && entry && (
          <Group
            title={t("agent.launch")}
            description={t("agent.launchHint")}
            action={
              entry.customized && (
                <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setConfirmReset(true)}>
                  {t("agent.reset")}
                </Button>
              )
            }
          >
            <Card>
              <div className="space-y-1.5 py-3">
                <label className="text-sm text-foreground" htmlFor="agent-command">
                  {t("agent.command")}
                </label>
                <Input
                  id="agent-command"
                  value={form.command}
                  onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                  className="font-mono text-sm"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-1.5 py-3">
                <label className="text-sm text-foreground" htmlFor="agent-args">
                  {t("agent.args")}
                </label>
                <Input
                  id="agent-args"
                  value={form.args}
                  onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                  className="font-mono text-sm"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-2 py-3">
                <p className="text-sm text-foreground">{t("agent.env")}</p>
                {envKeys.length > 0 && (
                  <ul className="space-y-1">
                    {envKeys.map((key) => (
                      <li key={key} className="flex items-center gap-2 rounded-lg bg-background px-3 py-1.5">
                        <span className="min-w-0 flex-1 truncate font-mono text-sm">{key}</span>
                        <span className="text-xs text-muted-foreground">{key in envSet ? t("agent.envPending") : t("agent.envSet")}</span>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t("common.delete")}
                          onClick={() => {
                            setEnvSet((e) => {
                              const next = { ...e }
                              delete next[key]
                              return next
                            })
                            if (entry.env_keys.includes(key)) setEnvRemoved((r) => [...r, key])
                          }}
                        >
                          <XIcon className="size-3.5" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={newEnv.key}
                    onChange={(e) => setNewEnv((n) => ({ ...n, key: e.target.value }))}
                    placeholder={t("agent.envName")}
                    aria-label={t("agent.envName")}
                    className="h-8 w-40 font-mono text-sm"
                    spellCheck={false}
                  />
                  <Input
                    type="password"
                    value={newEnv.value}
                    onChange={(e) => setNewEnv((n) => ({ ...n, value: e.target.value }))}
                    placeholder={t("agent.envValue")}
                    aria-label={t("agent.envValue")}
                    className="h-8 min-w-40 flex-1 font-mono text-sm"
                    autoComplete="off"
                  />
                  <Button variant="outline" size="sm" disabled={!newEnv.key.trim()} onClick={addEnv}>
                    <PlusIcon className="size-3.5" />
                    {t("agent.envAdd")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t("agent.envHint")}</p>
              </div>
            </Card>
          </Group>
        )}
      </div>

      {managed && (
        <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3">
          <Button size="sm" disabled={!dirty || saving || !online} onClick={() => void save()}>
            {saving && <LoaderCircleIcon className="size-3.5 animate-spin" />}
            {t("common.save")}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title={t("agent.stopBusyTitle", { agent: name })}
        description={t("agent.stopBusyDesc", { count: entry?.busy ?? 0 })}
        confirmLabel={t("agent.stop")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={() => void stop(true)}
      />
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={t("agent.resetTitle", { agent: name })}
        description={t("agent.resetDesc")}
        confirmLabel={t("agent.reset")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => void reset()}
      />
    </>
  )
}
