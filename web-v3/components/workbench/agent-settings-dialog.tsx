"use client"

// An agent's settings on one device (from its row on the device page; v2's runtime settings): on or off (it keeps its
// product name: only one the user added can be renamed, and removed), AA's approvals for agents that ask no one before they act (Pi: a Pi
// extension the device installs globally), whether it is running (one process for all of its conversations: stop it, or
// start it to check it can be used) and how long an idle conversation is kept open, the model gateway it uses (agents
// that can be pointed at one; the key is kept on the device and never shown again), and how it is started (where its
// program is, command, arguments, environment variables) with a way back to the Connector's defaults. Idle
// conversations switch to changed settings at once, replying ones when their turn ends. A Connector that does not
// manage agents yet offers only the check. There is no "defaults for new conversations": the device starts each one
// with the settings the agent's newest conversation was created with.
import { useEffect, useRef, useState } from "react"
import { DeadlineExceededError, MeshCallError } from "meshcall/web"
import { LoaderCircleIcon, SlidersHorizontalIcon, SquareTerminalIcon, WaypointsIcon } from "lucide-react"
import { toast } from "sonner"

import { ConfirmDialog } from "@/components/console/confirm-dialog"
import { DropdownSelect } from "@/components/dropdown-select"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { AgentIcon } from "@/components/workbench/agent-icon"
import { AgentSignInDialog, type SignInTarget } from "@/components/workbench/agent-sign-in-dialog"
import { EnvEditor, hasEnvChanges, NO_ENV_CHANGES } from "@/components/workbench/env-editor"
import { Card, Group, Row } from "@/components/workbench/settings-parts"
import { SplitDialog, type SplitSection } from "@/components/workbench/split-dialog"
import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import type { AgentEntry, AgentGateway, AgentUpdate, DeviceRecord } from "@/lib/types/v3"
import { isGatewayUrl, keepsGatewayKey } from "@/lib/workbench/agents"
import { joinArgs, splitArgs } from "@/lib/workbench/args"
import { signInNeeded, signInText, type SignInNeeded } from "@/lib/workbench/sign-in"

type TunnelDevice = Pick<DeviceRecord, "id" | "mode_hint" | "presence">

type Check =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "ready" }
  | { status: "failed"; reason: string; message: string; signIn: SignInNeeded | null }

/** How long an idle conversation's agent is kept, in minutes (0: never closed, the default). */
const IDLE_CLOSE_CHOICES = [0, 10, 30, 60, 180, 720]

/** What the gateways of each API are called, and what an address looks like. */
const GATEWAY_APIS: Record<AgentGateway["api"], { name: string; example: string }> = {
  anthropic: { name: "Anthropic Messages", example: "https://gateway.example.com" },
  "openai-chat": { name: "OpenAI Chat Completions", example: "https://gateway.example.com/v1" },
  "openai-responses": { name: "OpenAI Responses", example: "https://gateway.example.com/v1" },
}

/** How it is started, as the form edits it (the program: only the one the user named; a key: only a new one). */
function launchForm(entry: AgentEntry | null) {
  return {
    name: entry?.name ?? "",
    command: entry?.command ?? "",
    args: entry ? joinArgs(entry.args) : "",
    program: entry?.program_set ? (entry.program ?? "") : "",
    gatewayUrl: entry?.gateway?.base_url ?? "",
    gatewayKey: "",
    gatewayModel: entry?.gateway?.model ?? "",
  }
}

export function AgentSettingsDialog({
  open,
  onOpenChange,
  tunnelManager,
  device,
  agent,
  entry,
  managed,
  checkNow = false,
  onEntry,
  onStopped,
  onRemoved,
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
  /** Start it once right away, to see whether it can be used (it was just added). */
  checkNow?: boolean
  onEntry: (entry: AgentEntry) => void
  onStopped: () => void
  onRemoved: () => void
}) {
  // Each opening starts the form from the agent's current settings (and on the first section).
  const [openings, setOpenings] = useState(0)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setOpenings((n) => n + 1)
  }
  return (
    <AgentSettingsBody
      key={`${device?.id}:${agent.id}:${openings}`}
      open={open}
      onOpenChange={onOpenChange}
      tunnelManager={tunnelManager}
      device={device}
      agent={agent}
      entry={entry}
      managed={managed}
      checkNow={checkNow && open}
      onEntry={onEntry}
      onStopped={onStopped}
      onRemoved={onRemoved}
    />
  )
}

type AgentSection = "general" | "gateway" | "launch"

function AgentSettingsBody({
  open,
  onOpenChange,
  tunnelManager,
  device,
  agent,
  entry,
  managed,
  checkNow,
  onEntry,
  onStopped,
  onRemoved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  agent: { id: string; name: string }
  entry: AgentEntry | null
  managed: boolean
  checkNow: boolean
  onEntry: (entry: AgentEntry) => void
  onStopped: () => void
  onRemoved: () => void
}) {
  const { t } = useI18n()
  const online = device?.presence === "online"
  const name = entry?.name ?? agent.name

  // How it is started: edited here, saved together.
  const [form, setForm] = useState(() => launchForm(entry))
  const [env, setEnv] = useState(NO_ENV_CHANGES)
  const [saving, setSaving] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [check, setCheck] = useState<Check>({ status: "idle" })
  const [signIn, setSignIn] = useState<SignInTarget | null>(null)
  const [section, setSection] = useState<AgentSection | null>(null)

  // The gateway's part of a save, or why it cannot be saved.
  const gateway = entry?.gateway
  const gatewayUrl = form.gatewayUrl.trim()
  const gatewayChanged =
    gateway !== undefined &&
    (gatewayUrl !== (gateway.base_url ?? "") ||
      (gatewayUrl !== "" && (form.gatewayKey.trim() !== "" || form.gatewayModel.trim() !== (gateway.model ?? ""))))
  const gatewayProblem = !gatewayChanged || gatewayUrl === ""
    ? null
    : !isGatewayUrl(gatewayUrl)
      ? t("gateway.urlInvalid")
      : !form.gatewayKey.trim() && !keepsGatewayKey(gateway?.base_url, gatewayUrl)
        ? t("gateway.keyRequired")
        : gateway?.model_required && !form.gatewayModel.trim()
          ? t("gateway.modelRequired", { agent: name })
          : null

  const dirty =
    entry !== null &&
    (form.name.trim() !== entry.name ||
      form.command.trim() !== entry.command ||
      joinArgs(splitArgs(form.args)) !== joinArgs(entry.args) ||
      form.program.trim() !== launchForm(entry).program ||
      gatewayChanged ||
      hasEnvChanges(env))

  const update = async (patch: Omit<AgentUpdate, "id">) => {
    if (!tunnelManager || !device) return null
    try {
      const next = await tunnelManager.updateAgent(device, { id: agent.id, ...patch })
      onEntry(next)
      return next
    } catch (err) {
      const reason = err instanceof MeshCallError ? err.reason : undefined
      toast.error(
        reason === "program_not_found"
          ? t("install.programNotFound")
          : reason === "program_path_relative"
            ? t("install.programRelative")
            : reason === "agent_name_taken"
              ? t("addAgent.nameTaken")
              : reason === "command_not_found"
                ? t("addAgent.commandNotFound", { command: patch.command ?? "" })
                : err instanceof Error
                  ? err.message
                  : String(err)
      )
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
    if (gatewayProblem) {
      toast.error(gatewayProblem)
      return
    }
    if (entry.custom && !form.name.trim()) {
      toast.error(t("addAgent.nameRequired"))
      return
    }
    setSaving(true)
    const envPatch: Record<string, string | null> = { ...env.set }
    for (const key of env.removed) envPatch[key] = null
    const next = await update({
      ...(form.name.trim() !== entry.name ? { name: form.name.trim() } : {}),
      ...(command !== entry.command ? { command } : {}),
      ...(joinArgs(splitArgs(form.args)) !== joinArgs(entry.args) ? { args: splitArgs(form.args) } : {}),
      ...(form.program.trim() !== launchForm(entry).program ? { program: form.program.trim() } : {}),
      ...(gatewayChanged
        ? {
            gateway: gatewayUrl
              ? { base_url: gatewayUrl, model: form.gatewayModel.trim(), ...(form.gatewayKey.trim() ? { api_key: form.gatewayKey.trim() } : {}) }
              : { base_url: "" },
          }
        : {}),
      ...(Object.keys(envPatch).length ? { env: envPatch } : {}),
    })
    setSaving(false)
    if (!next) return
    setForm(launchForm(next))
    setEnv(NO_ENV_CHANGES)
    toast.success(next.running > 0 ? t("agent.savedRestart") : t("common.saved"))
  }

  const reset = async () => {
    setConfirmReset(false)
    const next = await update({ reset: true })
    if (!next) return
    setForm(launchForm(next))
    setEnv(NO_ENV_CHANGES)
    toast.success(t("common.saved"))
  }

  const remove = async () => {
    if (!tunnelManager || !device) return
    setRemoving(true)
    try {
      await tunnelManager.removeAgent(device, agent.id, (entry?.busy ?? 0) > 0)
      toast.success(t("agent.removed", { agent: name }))
      onRemoved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      setRemoving(false)
      setConfirmRemove(false)
    }
  }

  const removeGateway = async () => {
    const next = await update({ gateway: { base_url: "" } })
    if (!next) return
    setForm((f) => ({ ...f, gatewayUrl: "", gatewayKey: "", gatewayModel: "" }))
    toast.success(next.running > 0 ? t("agent.savedRestart") : t("common.saved"))
  }

  const stop = async (force: boolean) => {
    if (!tunnelManager || !device) return
    setConfirmStop(false)
    setStopping(true)
    try {
      await tunnelManager.stopAgent(device, agent.id, force)
      toast.success(t("agent.stopped"))
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
        setCheck({
          status: "failed",
          reason: err instanceof MeshCallError ? (err.reason ?? err.code) : "error",
          message: err instanceof Error ? err.message : String(err),
          signIn: signInNeeded(err),
        })
        return
      }
    }
  }

  // One that was just added: whether it speaks ACP shows only once it was started.
  const checked = useRef(false)
  useEffect(() => {
    if (!checkNow || checked.current) return
    checked.current = true
    queueMicrotask(() => void runCheck())
  })

  const idleLabel = (minutes: number) =>
    minutes === 0
      ? t("agent.idleNever")
      : minutes % 60 === 0
        ? t("agent.idleHours", { count: minutes / 60 })
        : t("agent.idleMinutes", { count: minutes })

  const signInMethods = (check.status === "failed" ? check.signIn?.methods : undefined) ?? entry?.sign_in ?? []
  let checkText: string | null = null
  if (check.status === "failed") {
    checkText =
      check.reason === "agent_auth_required"
        ? signInText(t, name, check.signIn)
        : check.reason === "agent_disabled"
          ? t("agent.disabledHint")
          : check.reason === "agent_not_installed"
            ? t("newConv.agentNotInstalled", { agent: name })
            : t("newConv.agentStartFailed", { agent: name, error: check.message })
  }

  const sections: SplitSection<AgentSection>[] = [
    { id: "general", label: t("settings.nav.general"), Icon: SlidersHorizontalIcon },
    ...(gateway ? [{ id: "gateway" as const, label: t("gateway.title"), Icon: WaypointsIcon }] : []),
    ...(managed && entry ? [{ id: "launch" as const, label: t("agent.launch"), Icon: SquareTerminalIcon }] : []),
  ]
  const shown = (sections.find((s) => s.id === section) ?? sections[0]).id
  const formSection = shown === "gateway" || shown === "launch" || (shown === "general" && entry?.custom === true)
  return (
    <>
      <SplitDialog
        open={open}
        onOpenChange={onOpenChange}
        title={name}
        heading={
          <span className="flex min-w-0 items-center gap-3">
            <AgentIcon agent={agent.id} name={name} className="size-6 shrink-0" />
            <span className="min-w-0">
              <span className="block truncate">{name}</span>
              <span className="block truncate text-xs font-normal text-muted-foreground">
                {entry ? (entry.builtin ? t("agent.builtin") : t("agent.custom")) : agent.id}
                {entry?.customized ? ` · ${t("agent.customized")}` : ""}
              </span>
            </span>
          </span>
        }
        description={t("agent.dialogDesc", { agent: name })}
        sections={sections}
        section={section}
        onSection={setSection}
        footer={
          managed && (formSection || dirty) ? (
            <div className="flex items-center justify-end gap-2">
              {dirty && <span className="mr-auto text-xs text-muted-foreground">{t("agent.unsaved")}</span>}
              <Button size="sm" disabled={!dirty || saving || !online} onClick={() => void save()}>
                {saving && <LoaderCircleIcon className="size-3.5 animate-spin" />}
                {t("common.save")}
              </Button>
            </div>
          ) : undefined
        }
      >
        <div className="space-y-6">
          {shown === "general" && (
            <>
              {!managed && <p className="rounded-2xl bg-card px-4 py-3 text-sm text-muted-foreground">{t("agent.unmanaged")}</p>}
              {managed && (
                <Group>
                  <Card>
                    {entry?.custom && (
                      <div className="space-y-1.5 py-3">
                        <label className="text-sm text-foreground" htmlFor="agent-name">
                          {t("addAgent.name")}
                        </label>
                        <Input
                          id="agent-name"
                          value={form.name}
                          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                          maxLength={128}
                          autoComplete="off"
                        />
                      </div>
                    )}
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
              <Group title={managed ? t("agent.running") : undefined}>
                <Card>
                  {managed && (
                    <Row
                      label={
                        !entry
                          ? t("common.loading")
                          : entry.running > 0
                            ? entry.sessions === 0
                              ? t("agent.runningIdle")
                              : t("agent.runningCount", { count: entry.sessions ?? entry.running })
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
                  {signInMethods.length > 0 && (
                    <Row label={t("agentSignIn.row")} hint={t("agentSignIn.rowHint")}>
                      <Button variant="outline" size="sm" disabled={!online} onClick={() => setSignIn({ id: agent.id, name, methods: signInMethods })}>
                        {t("agentSignIn.action")}
                      </Button>
                    </Row>
                  )}
                </Card>
              </Group>
              {entry?.custom && (
                <Group>
                  <Card>
                    <Row label={t("agent.remove")} hint={t("agent.removeHint")}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        disabled={!online || removing}
                        onClick={() => setConfirmRemove(true)}
                      >
                        {t("agent.remove")}
                      </Button>
                    </Row>
                  </Card>
                </Group>
              )}
            </>
          )}

          {shown === "gateway" && gateway && (
            <Group
              description={t("gateway.hint", { agent: name, api: GATEWAY_APIS[gateway.api].name })}
              action={
                gateway.base_url && (
                  <Button variant="ghost" size="xs" className="text-muted-foreground" disabled={!online} onClick={() => void removeGateway()}>
                    {t("gateway.remove")}
                  </Button>
                )
              }
            >
              <Card>
                <div className="space-y-1.5 py-3">
                  <label className="text-sm text-foreground" htmlFor="gateway-url">
                    {t("gateway.url")}
                  </label>
                  <Input
                    id="gateway-url"
                    value={form.gatewayUrl}
                    onChange={(e) => setForm((f) => ({ ...f, gatewayUrl: e.target.value }))}
                    placeholder={GATEWAY_APIS[gateway.api].example}
                    className="font-mono text-sm"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5 py-3">
                  <label className="text-sm text-foreground" htmlFor="gateway-key">
                    API Key
                  </label>
                  <Input
                    id="gateway-key"
                    type="password"
                    value={form.gatewayKey}
                    onChange={(e) => setForm((f) => ({ ...f, gatewayKey: e.target.value }))}
                    placeholder={keepsGatewayKey(gateway.base_url, gatewayUrl) ? t("gateway.keySaved") : undefined}
                    className="font-mono text-sm"
                    autoComplete="new-password"
                  />
                  <p className="text-xs text-muted-foreground">{t("gateway.keyHint")}</p>
                </div>
                <div className="space-y-1.5 py-3">
                  <label className="text-sm text-foreground" htmlFor="gateway-model">
                    {gateway.model_required ? t("gateway.model") : t("gateway.modelOptional")}
                  </label>
                  <Input
                    id="gateway-model"
                    value={form.gatewayModel}
                    onChange={(e) => setForm((f) => ({ ...f, gatewayModel: e.target.value }))}
                    className="font-mono text-sm"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>
              </Card>
            </Group>
          )}

          {shown === "launch" && entry && (
            <Group
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
                {entry.install && (
                  <div className="space-y-1.5 py-3">
                    <label className="text-sm text-foreground" htmlFor="agent-program">
                      {t("agent.program")}
                    </label>
                    <Input
                      id="agent-program"
                      value={form.program}
                      onChange={(e) => setForm((f) => ({ ...f, program: e.target.value }))}
                      placeholder={entry.program_set ? undefined : entry.program}
                      className="font-mono text-sm"
                      spellCheck={false}
                    />
                    <p className="text-xs text-muted-foreground">{t("agent.programHint")}</p>
                  </div>
                )}
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
                <EnvEditor saved={entry.env_keys} draft={env} onDraft={setEnv} />
              </Card>
            </Group>
          )}
        </div>
      </SplitDialog>

      <AgentSignInDialog
        target={signIn}
        onClose={() => setSignIn(null)}
        tunnelManager={tunnelManager}
        device={device}
        onSignedIn={() => void runCheck()}
      />
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
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t("agent.removeTitle", { agent: name })}
        description={(entry?.busy ?? 0) > 0 ? t("agent.removeBusyDesc", { count: entry?.busy ?? 0 }) : t("agent.removeDesc")}
        confirmLabel={t("agent.remove")}
        cancelLabel={t("common.cancel")}
        destructive
        pending={removing}
        onConfirm={() => void remove()}
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
