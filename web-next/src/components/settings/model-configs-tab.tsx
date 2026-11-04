"use client"

import * as React from "react"
import { ChevronRight, LogOut, RefreshCw, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { ChannelMark, ChannelRuntimes, channelLabel, useChannelState } from "@/components/settings/channel-runtimes"
import { SettingsSection } from "@/components/settings/settings-section"
import { AccountBlock, CopyButton } from "@/components/settings/tokens-account"
import { TokensChannel } from "@/components/settings/tokens-channel"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useWorkspace } from "@/components/workspace-context"
import type { DeviceRuntimeView, ModelChannel, ModelChannelState, ModelConfigOverview, ModelProfile, ModelProtocol } from "@/features/dashboard/types"
import { modelConfigApi } from "@/features/model-config/api"
import { NATIVE_CHANNEL, TOKENS_CHANNEL, channelReferenced, channelUsers, tokensWanted } from "@/features/model-config/channel"
import { MANUAL_PROTOCOL_CODES, parseModelIds, protocolBaseUrl } from "@/features/model-config/presentation"
import { isApiError } from "@/lib/api/errors"
import { cn } from "@/lib/utils"

/** Only what the page shows of a device. */
type ConnectorView = { id: string; name: string; status?: "online" | "offline" }

const PROTOCOLS: ModelProtocol[] = ["openai_responses", "openai_chat", "anthropic"]

/**
 * Run an action that may restart runtimes: first without interrupting
 * anything; if the Server answers `busy`, ask, then run it again allowing it.
 */
export function useInterruptConfirm() {
  const t = useTranslations("pages.settings.modelConfigs")
  const [pending, setPending] = React.useState<{ resume: () => void; cancel: () => void } | null>(null)
  const run = React.useCallback(async <T,>(action: (allowInterrupt: boolean) => Promise<T>): Promise<T | null> => {
    try {
      return await action(false)
    } catch (error) {
      if (!isApiError(error) || error.code !== "busy") throw error
    }
    const confirmed = await new Promise<boolean>((resolve) => {
      setPending({ resume: () => resolve(true), cancel: () => resolve(false) })
    })
    setPending(null)
    return confirmed ? action(true) : null
  }, [])
  const dialog = (
    <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) pending?.cancel() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("interruptTitle")}</DialogTitle>
          <DialogDescription>{t("interruptDescription")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => pending?.cancel()}>{t("cancel")}</Button>
          <Button variant="destructive" onClick={() => pending?.resume()}>{t("interruptContinue")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
  return { run, dialog }
}

/** Re-read the overview after an action; the push that follows is a second chance. */
export function useModelConfigChanged() {
  const { refreshModelConfig } = useWorkspace()
  return React.useCallback(() => { void refreshModelConfig().catch(() => undefined) }, [refreshModelConfig])
}

export function useErrorText() {
  const t = useTranslations("pages.settings.modelConfigs")
  return React.useCallback((error: unknown) => {
    const code = isApiError(error) ? error.code : null
    if (code && t.has(`errors.${code}`)) return t(`errors.${code}`)
    return t("errors.generic")
  }, [t])
}

export function ModelConfigsTab({ token, connectors }: { token: string; connectors: ConnectorView[] }) {
  const t = useTranslations("pages.settings.modelConfigs")
  const { modelConfig, runtimes, refreshModelConfig } = useWorkspace()
  const changed = useModelConfigChanged()
  const [loadFailed, setLoadFailed] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [selected, setSelected] = React.useState<string | null>(null)
  const errorText = useErrorText()

  React.useEffect(() => {
    // The link callback sends the browser back here with the reason it failed.
    const params = new URLSearchParams(window.location.search)
    const code = params.get("tokensLink")
    if (!code) return
    toast.error(t.has(`errors.${code}`) ? t(`errors.${code}`) : t("errors.generic"))
    params.delete("tokensLink")
    const query = params.toString()
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`)
  }, [t])

  // Opening the page reads the configuration itself; it does not wait for a push.
  const load = React.useCallback(() => {
    setLoadFailed(false)
    refreshModelConfig().catch(() => setLoadFailed(true))
  }, [refreshModelConfig])
  React.useEffect(() => {
    if (token) load()
  }, [load, token])

  if (!modelConfig) {
    return loadFailed ? (
      <div className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground">
        <span>{t("loadFailed")}</span>
        <Button size="sm" variant="outline" onClick={load}><RefreshCw data-icon="inline-start" />{t("retry")}</Button>
      </div>
    ) : <div className="flex justify-center py-10"><Spinner /></div>
  }

  return (
    <ModelChannels
      token={token}
      connectors={connectors}
      selected={selected}
      onSelect={setSelected}
      onCreate={() => setCreating(true)}
      creating={creating}
      onCloseCreate={() => setCreating(false)}
      errorText={errorText}
      changed={changed}
      modelConfig={modelConfig}
      runtimes={runtimes}
    />
  )
}

function ModelChannels({
  token,
  modelConfig,
  connectors,
  runtimes,
  selected,
  onSelect,
  onCreate,
  creating,
  onCloseCreate,
  errorText,
  changed,
}: {
  token: string
  modelConfig: ModelConfigOverview
  connectors: ConnectorView[]
  runtimes: DeviceRuntimeView[]
  selected: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  creating: boolean
  onCloseCreate: () => void
  errorText: (error: unknown) => string
  changed: () => void
}) {
  const t = useTranslations("pages.settings.modelConfigs")
  const { channel, accept } = useChannelState(modelConfig)
  const [making, setMaking] = React.useState(false)

  const tokensAvailable = Boolean(modelConfig.tokens?.available)
  const tokensProfile = modelConfig.profiles.find((profile) => profile.source === "tokens" && profile.state === "active")
  // The active Tokens profile belongs to the Anywhere channel; everything else is listed on its own.
  const listed = modelConfig.profiles.filter((profile) => profile !== tokensProfile)
  const enabled = listed.filter((profile) => profile.state === "active")
  const detached = listed.filter((profile) => profile.state !== "active")
  const channels = [NATIVE_CHANNEL, ...(tokensAvailable ? [TOKENS_CHANNEL] : []), ...enabled.map((item) => item.id), ...detached.map((item) => item.id)]
  const inUse = channel?.channel ?? null
  // The page opens on the default channel, where most runtimes are.
  const current = selected && channels.includes(selected) ? selected : inUse && channels.includes(inUse) ? inUse : NATIVE_CHANNEL
  const currentProfile = current === TOKENS_CHANNEL ? tokensProfile : listed.find((profile) => profile.id === current)
  // Runtimes actually on a channel; before the Server reports channels, the recorded assignments.
  const signOut = useTokensSignOut({ token, channel, runtimes, errorText, onAccepted: accept, onChanged: changed })
  // Changing the default does not move the page off the channel being looked at.
  React.useEffect(() => {
    if (selected === null && (channel || current !== NATIVE_CHANNEL)) onSelect(current)
  }, [channel, current, onSelect, selected])
  const usedBy = (id: ModelChannel, profile?: ModelProfile) => channel
    ? channelUsers(channel, id)
    : modelConfig.assignments.filter((item) => item.profileId === profile?.id).length

  const makeCurrent = async (id: ModelChannel) => {
    setMaking(true)
    try {
      accept(await modelConfigApi.setChannel(token, id))
      toast.success(t("current.switched"))
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setMaking(false)
      changed()
    }
  }
  const currentAction = (id: ModelChannel) => inUse === id ? null : (
    <Button
      size="sm"
      variant="outline"
      title={t("current.description")}
      disabled={making || !modelConfig.secretConfigured}
      onClick={() => void makeCurrent(id)}
    >
      {making ? <Spinner /> : null}{t("current.makeCurrent")}
    </Button>
  )
  const channelButton = (id: ModelChannel, name: string) => (
    <ChannelButton
      key={id}
      selected={current === id}
      onSelect={() => onSelect(id)}
      name={name}
      badge={inUse === id ? <Badge variant="secondary" className="shrink-0 font-normal">{t("current.inUse")}</Badge> : null}
      meta={<ChannelMark channel={channel} channelId={id} />}
    />
  )
  const runtimesOf = (id: ModelChannel) => (
    <ChannelRuntimes
      token={token}
      overview={modelConfig}
      channel={channel}
      channelId={id}
      connectors={connectors}
      runtimes={runtimes}
      errorText={errorText}
      onAccepted={accept}
      onChanged={changed}
    />
  )

  return (
    <div className="flex flex-col gap-4">
      {!modelConfig.secretConfigured ? (
        <Alert><AlertDescription>{t("secretMissing")}</AlertDescription></Alert>
      ) : null}
      <div className="grid items-start gap-8 md:grid-cols-[16rem_minmax(0,1fr)] md:gap-10 lg:gap-12">
        <nav aria-label={t("channels.title")} className="flex flex-col gap-1 md:sticky md:top-0">
          <ChannelGroup>
            {channelButton(NATIVE_CHANNEL, t("current.native"))}
            {tokensAvailable ? channelButton(TOKENS_CHANNEL, t("channels.anywhere")) : null}
          </ChannelGroup>
          {enabled.length ? (
            <ChannelGroup title={t("channels.manual")}>
              {enabled.map((profile) => channelButton(profile.id, profile.name))}
            </ChannelGroup>
          ) : null}
          {detached.length ? (
            <ChannelGroup title={t("channels.detached")}>
              {detached.map((profile) => channelButton(profile.id, profile.name))}
            </ChannelGroup>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 justify-start px-2 text-muted-foreground"
            onClick={onCreate}
            disabled={!modelConfig.secretConfigured}
          >
            {t("addProfile")}
          </Button>
        </nav>

        <section className="flex min-w-0 flex-col gap-8">
          {current === NATIVE_CHANNEL ? (
            <SettingsSection
              variant="plain"
              title={t("current.native")}
              description={t("native.description")}
              action={currentAction(NATIVE_CHANNEL)}
            />
          ) : current === TOKENS_CHANNEL ? (
            <TokensChannel
              token={token}
              overview={modelConfig}
              currentAction={currentAction(TOKENS_CHANNEL)}
              signOut={(
                <TokensSignOut
                  fallback={channelLabel(modelConfig, inUse && inUse !== TOKENS_CHANNEL ? inUse : NATIVE_CHANNEL, t)}
                  busy={signOut.busy}
                  onSignOut={() => void signOut.start()}
                />
              )}
              connection={tokensProfile ? (
                <TokensConnection token={token} profile={tokensProfile} usedBy={usedBy(TOKENS_CHANNEL, tokensProfile)} errorText={errorText} />
              ) : null}
              runtimes={channel ? runtimesOf(TOKENS_CHANNEL) : null}
              errorText={errorText}
              onChanged={changed}
            />
          ) : currentProfile ? (
            <SettingsSection
              variant="plain"
              title={currentProfile.name}
              description={t("profilesDescription")}
              action={currentProfile.source === "manual" && currentProfile.state === "active" ? currentAction(currentProfile.id) : null}
            >
              <ProfileRow
                key={currentProfile.id}
                token={token}
                profile={currentProfile}
                usedBy={usedBy(currentProfile.id, currentProfile)}
                referenced={channelReferenced(channel, currentProfile.id)}
                errorText={errorText}
                defaultExpanded
              />
            </SettingsSection>
          ) : null}
          {channel && !(current === TOKENS_CHANNEL && modelConfig.tokens?.link?.status === "linked") ? runtimesOf(current) : null}
        </section>
      </div>
      {creating ? <ProfileDialog token={token} onClose={onCloseCreate} errorText={errorText} /> : null}
    </div>
  )
}

function ChannelGroup({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      {title ? <span className="px-2 pb-1 pt-2 text-xs text-muted-foreground">{title}</span> : null}
      {children}
    </div>
  )
}

function ChannelButton({
  selected,
  onSelect,
  name,
  badge,
  meta,
}: {
  selected: boolean
  onSelect: () => void
  name: string
  /** Marks the current channel. */
  badge: React.ReactNode
  /** How many runtimes should use it, and whether they got there. */
  meta: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
        selected && "bg-accent font-medium",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {badge}
      {meta}
    </button>
  )
}


/**
 * Leave the Anywhere account. Unlinking kills its key, so every runtime on it
 * moves first: to the default channel, or to the device's own configuration
 * when Anywhere was the default. The account is unlinked once none uses it.
 * Kept by the page, so looking at another channel meanwhile does not stop it.
 */
function useTokensSignOut({
  token,
  channel,
  runtimes,
  errorText,
  onAccepted,
  onChanged,
}: {
  token: string
  channel: ModelChannelState | null
  runtimes: DeviceRuntimeView[]
  errorText: (error: unknown) => string
  onAccepted: (state: unknown) => void
  onChanged: () => void
}) {
  const t = useTranslations("pages.settings.modelConfigs")
  // "waiting": the runtimes are still switching away; unlink when they are done.
  const [phase, setPhase] = React.useState<"idle" | "working" | "waiting">("idle")
  const unlinking = React.useRef(false)

  const unlink = React.useCallback(async () => {
    if (unlinking.current) return
    unlinking.current = true
    setPhase("working")
    try {
      const { revoked } = await modelConfigApi.unlinkTokens(token)
      toast.success(t(revoked ? "signedOut" : "unlinkedNotRevoked"))
      setPhase("idle")
      onChanged()
    } catch (error) {
      if (isApiError(error) && error.code === "channel_in_use") {
        setPhase("waiting")
      } else {
        toast.error(errorText(error))
        setPhase("idle")
      }
    } finally {
      unlinking.current = false
    }
  }, [errorText, onChanged, t, token])

  React.useEffect(() => {
    if (phase === "waiting" && channel && !tokensWanted(channel)) void unlink()
  }, [channel, phase, unlink])

  const start = async () => {
    setPhase("working")
    try {
      let state = channel
      if (!state || state.channel === TOKENS_CHANNEL) {
        state = await modelConfigApi.setChannel(token, NATIVE_CHANNEL)
        onAccepted(state)
      }
      for (const row of state.runtimes.filter((item) => item.override === TOKENS_CHANNEL)) {
        // Following a default other than its own configuration would rewrite its global settings again.
        const scope = runtimes.find((item) => item.connectorId === row.connectorId && item.runtimeId === row.runtimeId)?.modelConnection?.scope
        const value = scope === "native_global" && state.channel !== NATIVE_CHANNEL ? NATIVE_CHANNEL : null
        state = await modelConfigApi.setRuntimeChannel(token, row, value)
        onAccepted(state)
      }
    } catch (error) {
      toast.error(errorText(error))
      setPhase("idle")
      onChanged()
      return
    }
    onChanged()
    await unlink()
  }

  return { busy: phase !== "idle", start }
}

function TokensSignOut({ fallback, busy, onSignOut }: { fallback: string; busy: boolean; onSignOut: () => void }) {
  const t = useTranslations("pages.settings.modelConfigs")
  if (busy) {
    return (
      <span role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />{t("signingOut")}
      </span>
    )
  }
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost"><LogOut data-icon="inline-start" />{t("signOut")}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("signOutTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("signOutDescription", { channel: fallback })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onSignOut}>{t("signOut")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Where runtimes reach the Anywhere channel and with which key. */
function TokensConnection({
  token,
  profile,
  usedBy,
  errorText,
}: {
  token: string
  profile: ModelProfile
  usedBy: number
  errorText: (error: unknown) => string
}) {
  const t = useTranslations("pages.settings.modelConfigs")
  const [busy, setBusy] = React.useState(false)
  const interrupt = useInterruptConfirm()
  const changed = useModelConfigChanged()

  const rotate = async () => {
    setBusy(true)
    try {
      const rotated = await interrupt.run((allow) => modelConfigApi.rotateTokensKey(token, profile.id, allow))
      if (rotated !== null) {
        toast.success(t("rotated"))
        changed()
      }
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AccountBlock
      title={t("channels.connection")}
      action={(
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="ghost" disabled={busy}>
              {busy ? <Spinner /> : <RefreshCw data-icon="inline-start" />}{t("rotate")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("rotate")}</AlertDialogTitle>
              <AlertDialogDescription>{t("rotateDescription")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => void rotate()} disabled={busy}>
                {t("rotate")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    >
      {interrupt.dialog}
      <dl className="flex flex-col divide-y divide-border rounded-lg border border-border text-sm">
        <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1.5">
          <dt className="w-20 shrink-0 text-muted-foreground">{t("address")}</dt>
          <dd className="min-w-0 flex-1 break-all">{profile.originHost}</dd>
          <CopyButton value={profile.originHost} />
        </div>
        {profile.keyHint ? (
          <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1.5">
            <dt className="w-20 shrink-0 text-muted-foreground">{t("apiKey")}</dt>
            {/* Only the ends of the key are kept, so there is nothing to copy. */}
            <dd className="min-w-0 flex-1 break-all font-mono" title={t("apiKeyWriteOnly")}>{profile.keyHint}</dd>
          </div>
        ) : null}
        <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1.5">
          <dt className="w-20 shrink-0 text-muted-foreground">{t("usage")}</dt>
          <dd className="min-w-0 flex-1">{usedBy ? t("usedBy", { count: usedBy }) : t("unused")}</dd>
        </div>
      </dl>
    </AccountBlock>
  )
}

function ProfileRow({
  token,
  profile,
  usedBy,
  referenced,
  errorText,
  defaultExpanded = false,
}: {
  token: string
  profile: ModelProfile
  usedBy: number
  /** Current, chosen for a runtime, or in use: the Server refuses to delete it. */
  referenced: boolean
  errorText: (error: unknown) => string
  defaultExpanded?: boolean
}) {
  const t = useTranslations("pages.settings.modelConfigs")
  const [busy, setBusy] = React.useState(false)
  const changed = useModelConfigChanged()
  const [expanded, setExpanded] = React.useState(defaultExpanded)
  const detailsId = React.useId()

  const remove = async () => {
    setBusy(true)
    try {
      await modelConfigApi.deleteProfile(token, profile.id)
      changed()
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-48 flex-wrap items-center gap-2">
          <span className="break-words font-medium">{profile.name}</span>
          {/* The Tokens profile is already named after its source. */}
          {profile.name !== t(`source.${profile.source}`) ? (
            <Badge variant="secondary">{t(`source.${profile.source}`)}</Badge>
          ) : null}
          {profile.state === "detached" ? <Badge variant="outline">{t("detached")}</Badge> : null}
        </div>
        <div className="flex shrink-0 gap-2">
          {profile.source === "manual" || profile.state === "detached" ? (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => void remove()}
              disabled={busy || referenced || usedBy > 0}
              title={referenced || usedBy > 0 ? t("deleteInUse") : undefined}
              aria-label={t("deleteProfile")}
            >
              <Trash2 />
            </Button>
          ) : null}
        </div>
      </div>
      {/* Every value is labelled and wraps instead of being cut off. */}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">{t("address")}</dt>
        <dd className="break-all">{profile.originHost}</dd>
        {profile.keyHint ? (
          <>
            <dt className="text-muted-foreground">{t("apiKey")}</dt>
            <dd className="break-all font-mono">{profile.keyHint}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t("usage")}</dt>
        <dd>{usedBy ? t("usedBy", { count: usedBy }) : t("unused")}</dd>
        <dt className="text-muted-foreground">{t("protocolsLabel")}</dt>
        <dd className="flex flex-wrap gap-1.5">
          {profile.offers.map((offer) => (
            <Badge key={offer.format} variant="outline" className="font-normal">
              {t(`protocolsShort.${offer.format}`)}
              <span className="text-muted-foreground">
                {offer.models.length ? t("modelCount", { count: offer.models.length }) : t("modelsDiscovered")}
              </span>
            </Badge>
          ))}
        </dd>
      </dl>
      <button
        type="button"
        className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((current) => !current)}
      >
        <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
        {expanded ? t("hideModels") : t("showModels")}
      </button>
      {expanded ? (
        <div id={detailsId} className="flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-3 text-xs">
          {profile.offers.map((offer) => (
            <div key={offer.format} className="flex flex-col gap-1.5">
              <span className="font-medium">{t(`protocols.${offer.format}`)}</span>
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5">
                <dt className="text-muted-foreground">{t("address")}</dt>
                <dd className="break-all">{offer.baseUrl}</dd>
                <dt className="text-muted-foreground">{t("models")}</dt>
                <dd>
              {offer.models.length ? (
                <ul className="flex flex-wrap gap-1.5">
                  {offer.models.map((model) => (
                    <li key={model.id} className="break-all rounded border border-border bg-background px-1.5 py-0.5">
                      {model.name && model.name !== model.id ? (
                        <>{model.name} <span className="font-mono text-muted-foreground">{model.id}</span></>
                      ) : <span className="font-mono">{model.id}</span>}
                    </li>
                  ))}
                </ul>
              ) : <span className="text-muted-foreground">{t("modelsDiscoveredDescription")}</span>}
                </dd>
              </dl>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

type OfferDraft = { enabled: boolean; baseUrl: string; models: string }

const HTTP_URL = /^https?:\/\/\S+$/

function ProfileDialog({ token, onClose, errorText }: { token: string; onClose: () => void; errorText: (error: unknown) => string }) {
  const t = useTranslations("pages.settings.modelConfigs")
  const [name, setName] = React.useState("")
  const [apiKey, setApiKey] = React.useState("")
  const [baseUrl, setBaseUrl] = React.useState("")
  // The server detects the protocols from the address; only when it cannot are they entered by hand.
  const [manual, setManual] = React.useState(false)
  const [failure, setFailure] = React.useState<string | null>(null)
  const [offers, setOffers] = React.useState<Record<ModelProtocol, OfferDraft>>({
    openai_responses: { enabled: false, baseUrl: "", models: "" },
    openai_chat: { enabled: true, baseUrl: "", models: "" },
    anthropic: { enabled: false, baseUrl: "", models: "" },
  })
  const [saving, setSaving] = React.useState(false)
  const changed = useModelConfigChanged()
  const chosen = PROTOCOLS.filter((protocol) => offers[protocol].enabled)
  const valid = name.trim() && apiKey.trim() && (manual
    ? chosen.length > 0 && chosen.every((protocol) => HTTP_URL.test(offers[protocol].baseUrl.trim()))
    : HTTP_URL.test(baseUrl.trim()))

  const save = async () => {
    setSaving(true)
    setFailure(null)
    try {
      await modelConfigApi.createProfile(token, manual
        ? {
            name: name.trim(),
            apiKey: apiKey.trim(),
            offers: chosen.map((protocol) => ({
              format: protocol,
              baseUrl: offers[protocol].baseUrl.trim(),
              models: parseModelIds(offers[protocol].models).map((id) => ({ id })),
            })),
          }
        : { name: name.trim(), apiKey: apiKey.trim(), baseUrl: baseUrl.trim() })
      toast.success(t("profileSaved"))
      changed()
      onClose()
    } catch (error) {
      const code = isApiError(error) ? error.code : undefined
      if (!manual && code && MANUAL_PROTOCOL_CODES.includes(code)) {
        setOffers((current) => {
          const next = { ...current }
          for (const protocol of PROTOCOLS) next[protocol] = { ...current[protocol], baseUrl: protocolBaseUrl(baseUrl, protocol) }
          return next
        })
        setManual(true)
      }
      setFailure(errorText(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("addProfile")}</DialogTitle>
          <DialogDescription>{t("addProfileDescription")}</DialogDescription>
        </DialogHeader>
        <FieldGroup className="max-h-[60vh] gap-4 overflow-y-auto">
          <Field>
            <FieldLabel htmlFor="model-profile-name">{t("profileName")}</FieldLabel>
            <Input id="model-profile-name" value={name} maxLength={64} disabled={saving} onChange={(event) => setName(event.currentTarget.value)} />
          </Field>
          {manual ? null : (
            <Field>
              <FieldLabel htmlFor="model-profile-url">{t("baseUrl")}</FieldLabel>
              <Input
                id="model-profile-url"
                value={baseUrl}
                placeholder={t("baseUrlPlaceholder")}
                inputMode="url"
                spellCheck={false}
                disabled={saving}
                onChange={(event) => setBaseUrl(event.currentTarget.value)}
              />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="model-profile-key">{t("apiKey")}</FieldLabel>
            <Input
              id="model-profile-key"
              type="password"
              value={apiKey}
              autoComplete="new-password"
              spellCheck={false}
              disabled={saving}
              data-1p-ignore
              data-lpignore="true"
              onChange={(event) => setApiKey(event.currentTarget.value)}
            />
            <FieldDescription>{t("apiKeyWriteOnly")}</FieldDescription>
          </Field>
          {failure ? <Alert variant="destructive"><AlertDescription>{failure}</AlertDescription></Alert> : null}
          {manual ? <p className="text-sm text-muted-foreground">{t("manualProtocols")}</p> : null}
          {manual ? PROTOCOLS.map((protocol) => (
            <div key={protocol} className="flex flex-col gap-3 rounded-md border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox
                  checked={offers[protocol].enabled}
                  onCheckedChange={(checked) => setOffers((current) => ({ ...current, [protocol]: { ...current[protocol], enabled: checked === true } }))}
                />
                {t(`protocols.${protocol}`)}
              </label>
              {offers[protocol].enabled ? (
                <>
                  <Input
                    value={offers[protocol].baseUrl}
                    placeholder={t("baseUrlPlaceholder")}
                    inputMode="url"
                    spellCheck={false}
                    aria-label={t("baseUrl")}
                    onChange={(event) => {
                      const baseUrl = event.currentTarget.value
                      setOffers((current) => ({ ...current, [protocol]: { ...current[protocol], baseUrl } }))
                    }}
                  />
                  <Textarea
                    value={offers[protocol].models}
                    placeholder={t("modelsPlaceholder")}
                    aria-label={t("models")}
                    className="min-h-20 font-mono text-xs"
                    spellCheck={false}
                    onChange={(event) => {
                      const models = event.currentTarget.value
                      setOffers((current) => ({ ...current, [protocol]: { ...current[protocol], models } }))
                    }}
                  />
                </>
              ) : null}
            </div>
          )) : null}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>{t("cancel")}</Button>
          <Button onClick={() => void save()} disabled={!valid || saving}>
            {saving ? <Spinner /> : null}
            {saving && !manual ? t("detecting") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
