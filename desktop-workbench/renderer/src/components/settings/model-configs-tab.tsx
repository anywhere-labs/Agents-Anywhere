"use client"

import * as React from "react"
import { Link2, Plus, RefreshCw, RotateCcw, Trash2, Unlink, Upload } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { RuntimeMaturityBadge } from "@/components/runtime-maturity-badge"
import { SettingsSection } from "@/components/settings/settings-section"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useWorkspace } from "@/components/workspace-context"
import type {
  DeviceRuntimeView,
  ModelAssignment,
  ModelConfigOverview,
  ModelProfile,
  ModelProtocol,
} from "@/features/dashboard/types"
import { modelConfigApi, type ModelOperation, type ModelPreviewTarget } from "@/features/model-config/api"
import {
  assignmentStatusTone,
  connectionStateTone,
  modelConfigurableRuntimes,
  newIdempotencyKey,
  parseModelIds,
  type ModelStatusTone,
} from "@/features/model-config/presentation"
import { isApiError } from "@/lib/api/errors"
import { openTokensLinkStart } from "@/features/model-config/open-link"

/** Only what the page shows of a device. */
type ConnectorView = { id: string; name: string }

const PROTOCOLS: ModelProtocol[] = ["openai_responses", "openai_chat", "anthropic"]

const TONE_CLASS: Record<ModelStatusTone, string> = {
  ok: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
  progress: "border-sky-500/40 text-sky-700 dark:text-sky-400",
  warning: "border-amber-500/40 text-amber-700 dark:text-amber-400",
  error: "border-destructive/40 text-destructive",
  neutral: "text-muted-foreground",
}

function useErrorText() {
  const t = useTranslations("pages.settings.modelConfigs")
  return React.useCallback((error: unknown) => {
    const code = isApiError(error) ? error.code : null
    if (code && t.has(`errors.${code}`)) return t(`errors.${code}`)
    return t("errors.generic")
  }, [t])
}

export function ModelConfigsTab({ token, connectors }: { token: string; connectors: ConnectorView[] }) {
  const t = useTranslations("pages.settings.modelConfigs")
  const { modelConfig, runtimes } = useWorkspace()
  const [applyProfile, setApplyProfile] = React.useState<ModelProfile | null>(null)
  const [creating, setCreating] = React.useState(false)
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

  if (!modelConfig) return <div className="flex justify-center py-10"><Spinner /></div>

  const profiles = modelConfig.profiles
  return (
    <div className="flex flex-col gap-6">
      {!modelConfig.secretConfigured ? (
        <Alert><AlertDescription>{t("secretMissing")}</AlertDescription></Alert>
      ) : null}
      <TokensSection token={token} overview={modelConfig} errorText={errorText} />
      <SettingsSection
        title={t("profilesTitle")}
        description={t("profilesDescription")}
        action={(
          <Button size="sm" variant="outline" onClick={() => setCreating(true)} disabled={!modelConfig.secretConfigured}>
            <Plus data-icon="inline-start" />{t("addProfile")}
          </Button>
        )}
      >
        {profiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noProfiles")}</p>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {profiles.map((profile) => (
              <ProfileRow
                key={profile.id}
                token={token}
                profile={profile}
                usedBy={modelConfig.assignments.filter((item) => item.profileId === profile.id).length}
                onApply={() => setApplyProfile(profile)}
                errorText={errorText}
              />
            ))}
          </div>
        )}
      </SettingsSection>
      <DevicesSection
        token={token}
        connectors={connectors}
        runtimes={modelConfigurableRuntimes(runtimes)}
        overview={modelConfig}
        errorText={errorText}
      />
      {creating ? <ProfileDialog token={token} onClose={() => setCreating(false)} errorText={errorText} /> : null}
      {applyProfile ? (
        <ApplyDialog
          token={token}
          profile={applyProfile}
          connectors={connectors}
          onClose={() => setApplyProfile(null)}
          errorText={errorText}
        />
      ) : null}
    </div>
  )
}

function TokensSection({ token, overview, errorText }: { token: string; overview: ModelConfigOverview; errorText: (error: unknown) => string }) {
  const t = useTranslations("pages.settings.modelConfigs")
  const [busy, setBusy] = React.useState<"link" | "sync" | "unlink" | null>(null)
  const [confirmUnlink, setConfirmUnlink] = React.useState(false)
  const [allowInterrupt, setAllowInterrupt] = React.useState(false)
  const tokens = overview.tokens
  if (!tokens?.available) return null
  const link = tokens.link
  const tokensProfile = overview.profiles.find((profile) => profile.source === "tokens" && profile.state === "active")
  const usedBy = tokensProfile ? overview.assignments.filter((item) => item.profileId === tokensProfile.id).length : 0

  const run = async (kind: "link" | "sync" | "unlink", action: () => Promise<unknown>) => {
    setBusy(kind)
    try {
      await action()
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(null)
    }
  }

  const startLink = () => run("link", async () => {
    const { startUrl } = await modelConfigApi.beginTokensLink(token)
    await openTokensLinkStart(startUrl)
    toast.message(t("linkOpened"))
  })

  return (
    <SettingsSection
      title={t("tokensTitle")}
      description={link
        ? link.status === "linked"
          ? t("tokensLinked", { account: link.account.displayName ?? link.account.email ?? link.account.id })
          : t("tokensReauth")
        : t("tokensDescription")}
      action={(
        <div className="flex flex-wrap gap-2">
          {!link || link.status === "reauth_required" ? (
            <Button size="sm" onClick={() => void startLink()} disabled={busy !== null || !tokens.secretConfigured}>
              {busy === "link" ? <Spinner /> : <Link2 data-icon="inline-start" />}
              {link ? t("relink") : t("link")}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => void run("sync", async () => {
              await modelConfigApi.syncTokens(token)
              toast.success(t("synced"))
            })} disabled={busy !== null}>
              {busy === "sync" ? <Spinner /> : <RefreshCw data-icon="inline-start" />}
              {t("sync")}
            </Button>
          )}
          {link ? (
            <Button size="sm" variant="ghost" onClick={() => setConfirmUnlink(true)} disabled={busy !== null}>
              <Unlink data-icon="inline-start" />{t("unlink")}
            </Button>
          ) : null}
        </div>
      )}
    >
      {link?.relinkSoon ? <p className="text-sm text-amber-700 dark:text-amber-400">{t("relinkSoon")}</p> : null}
      {link && !tokensProfile ? <p className="text-sm text-muted-foreground">{t("tokensNotSynced")}</p> : null}
      <Dialog open={confirmUnlink} onOpenChange={setConfirmUnlink}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("unlinkTitle")}</DialogTitle>
            <DialogDescription>{t("unlinkDescription", { count: usedBy })}</DialogDescription>
          </DialogHeader>
          {usedBy > 0 ? (
            <Field orientation="horizontal">
              <FieldLabel htmlFor="tokens-unlink-interrupt">{t("allowInterrupt")}</FieldLabel>
              <Switch id="tokens-unlink-interrupt" checked={allowInterrupt} onCheckedChange={setAllowInterrupt} />
            </Field>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmUnlink(false)}>{t("cancel")}</Button>
            <Button variant="destructive" disabled={busy !== null} onClick={() => void run("unlink", async () => {
              const result = await modelConfigApi.unlinkTokens(token, allowInterrupt)
              setConfirmUnlink(false)
              const failed = result.results.filter((item) => item.result !== "restored").length
              if (failed) toast.warning(t("unlinkedWithFailures", { count: failed }))
              else toast.success(result.revoked ? t("unlinked") : t("unlinkedNotRevoked"))
            })}>
              {busy === "unlink" ? <Spinner /> : null}{t("unlink")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  )
}

function ProfileRow({
  token,
  profile,
  usedBy,
  onApply,
  errorText,
}: {
  token: string
  profile: ModelProfile
  usedBy: number
  onApply: () => void
  errorText: (error: unknown) => string
}) {
  const t = useTranslations("pages.settings.modelConfigs")
  const [busy, setBusy] = React.useState(false)
  const models = new Set(profile.offers.flatMap((offer) => offer.models.map((model) => model.id))).size

  const remove = async () => {
    setBusy(true)
    try {
      await modelConfigApi.deleteProfile(token, profile.id)
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const rotate = async () => {
    setBusy(true)
    try {
      const operation = await modelConfigApi.rotateTokensKey(token, profile.id, false, newIdempotencyKey())
      reportOperation(operation, t)
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 py-3">
      <div className="flex min-w-0 flex-1 basis-60 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{profile.name}</span>
          <Badge variant="secondary">{t(`source.${profile.source}`)}</Badge>
          {profile.state === "detached" ? <Badge variant="outline">{t("detached")}</Badge> : null}
        </div>
        <span className="text-xs text-muted-foreground">
          {[
            profile.originHost,
            profile.offers.map((offer) => t(`protocols.${offer.format}`)).join(" / "),
            t("modelCount", { count: models }),
            profile.keyHint ? t("keyHint", { hint: profile.keyHint }) : null,
            usedBy ? t("usedBy", { count: usedBy }) : null,
          ].filter(Boolean).join(" · ")}
        </span>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={onApply} disabled={busy || profile.state !== "active"}>
          <Upload data-icon="inline-start" />{t("apply")}
        </Button>
        {profile.source === "tokens" && profile.state === "active" ? (
          <Button size="sm" variant="ghost" onClick={() => void rotate()} disabled={busy} title={t("rotateDescription")}>
            <RefreshCw data-icon="inline-start" />{t("rotate")}
          </Button>
        ) : null}
        {profile.source === "manual" || profile.state === "detached" ? (
          <Button size="icon-sm" variant="ghost" onClick={() => void remove()} disabled={busy || usedBy > 0} aria-label={t("deleteProfile")}>
            <Trash2 />
          </Button>
        ) : null}
      </div>
    </div>
  )
}

type OfferDraft = { enabled: boolean; baseUrl: string; models: string }

function ProfileDialog({ token, onClose, errorText }: { token: string; onClose: () => void; errorText: (error: unknown) => string }) {
  const t = useTranslations("pages.settings.modelConfigs")
  const [name, setName] = React.useState("")
  const [apiKey, setApiKey] = React.useState("")
  const [offers, setOffers] = React.useState<Record<ModelProtocol, OfferDraft>>({
    openai_responses: { enabled: false, baseUrl: "", models: "" },
    openai_chat: { enabled: true, baseUrl: "", models: "" },
    anthropic: { enabled: false, baseUrl: "", models: "" },
  })
  const [saving, setSaving] = React.useState(false)
  const chosen = PROTOCOLS.filter((protocol) => offers[protocol].enabled)
  const valid = name.trim() && apiKey.trim() && chosen.length > 0
    && chosen.every((protocol) => /^https?:\/\/\S+$/.test(offers[protocol].baseUrl.trim()))

  const save = async () => {
    setSaving(true)
    try {
      await modelConfigApi.createProfile(token, {
        name: name.trim(),
        apiKey: apiKey.trim(),
        offers: chosen.map((protocol) => ({
          format: protocol,
          baseUrl: offers[protocol].baseUrl.trim(),
          models: parseModelIds(offers[protocol].models).map((id) => ({ id })),
        })),
      })
      toast.success(t("profileSaved"))
      onClose()
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("addProfile")}</DialogTitle>
          <DialogDescription>{t("addProfileDescription")}</DialogDescription>
        </DialogHeader>
        <FieldGroup className="max-h-[60vh] gap-4 overflow-y-auto">
          <Field>
            <FieldLabel htmlFor="model-profile-name">{t("profileName")}</FieldLabel>
            <Input id="model-profile-name" value={name} maxLength={64} onChange={(event) => setName(event.currentTarget.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="model-profile-key">{t("apiKey")}</FieldLabel>
            <Input
              id="model-profile-key"
              type="password"
              value={apiKey}
              autoComplete="new-password"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              onChange={(event) => setApiKey(event.currentTarget.value)}
            />
            <FieldDescription>{t("apiKeyWriteOnly")}</FieldDescription>
          </Field>
          {PROTOCOLS.map((protocol) => (
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
          ))}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("cancel")}</Button>
          <Button onClick={() => void save()} disabled={!valid || saving}>{saving ? <Spinner /> : null}{t("save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ApplyDialog({
  token,
  profile,
  connectors,
  onClose,
  errorText,
}: {
  token: string
  profile: ModelProfile
  connectors: ConnectorView[]
  onClose: () => void
  errorText: (error: unknown) => string
}) {
  const t = useTranslations("pages.settings.modelConfigs")
  const [targets, setTargets] = React.useState<ModelPreviewTarget[] | null>(null)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [allowInterrupt, setAllowInterrupt] = React.useState(false)
  const [confirmGlobal, setConfirmGlobal] = React.useState(false)
  const [applying, setApplying] = React.useState(false)
  const idempotencyKey = React.useRef(newIdempotencyKey())
  const deviceName = (connectorId: string) => connectors.find((item) => item.id === connectorId)?.name ?? connectorId
  const keyOf = (target: { connectorId: string; runtimeId: string }) => `${target.connectorId}/${target.runtimeId}`

  React.useEffect(() => {
    let cancelled = false
    modelConfigApi.preview(token, profile.id).then((preview) => {
      if (cancelled) return
      setTargets(preview.targets)
      // Changing a runtime's own global settings is never preselected.
      setSelected(new Set(preview.targets
        .filter((item) => item.decision === "apply" && !item.requiresConfirmation && !item.tooManyModels)
        .map(keyOf)))
    }).catch((error) => {
      if (!cancelled) {
        toast.error(errorText(error))
        onClose()
      }
    })
    return () => { cancelled = true }
  }, [errorText, onClose, profile.id, token])

  const chosen = (targets ?? []).filter((item) => selected.has(keyOf(item)))
  const needsGlobal = chosen.some((item) => item.requiresConfirmation)
  const running = chosen.reduce((sum, item) => sum + (item.effect === "restart" ? item.runningSessions ?? 0 : 0), 0)

  const apply = async () => {
    setApplying(true)
    try {
      const operation = await modelConfigApi.apply(token, {
        profileId: profile.id,
        targets: chosen.map(({ connectorId, runtimeId }) => ({ connectorId, runtimeId })),
        allowInterrupt,
        confirmNativeGlobal: confirmGlobal,
      }, idempotencyKey.current)
      reportOperation(operation, t)
      onClose()
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("applyTitle", { name: profile.name })}</DialogTitle>
          <DialogDescription>{t("applyDescription")}</DialogDescription>
        </DialogHeader>
        {!targets ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : targets.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noTargets")}</p>
        ) : (
          <div className="flex max-h-[50vh] flex-col divide-y divide-border overflow-y-auto">
            {targets.map((item) => {
              const key = keyOf(item)
              const disabled = item.decision !== "apply" || Boolean(item.tooManyModels)
              return (
                <label key={key} className="flex items-start gap-3 py-3">
                  <Checkbox
                    className="mt-0.5"
                    checked={selected.has(key)}
                    disabled={disabled}
                    onCheckedChange={(checked) => setSelected((current) => {
                      const next = new Set(current)
                      if (checked === true) next.add(key)
                      else next.delete(key)
                      return next
                    })}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{item.name ?? item.runtimeId}</span>
                      <span className="text-muted-foreground">{deviceName(item.connectorId)}</span>
                      <RuntimeMaturityBadge maturity={item.capabilityMaturity ?? item.maturity} />
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {item.decision === "apply"
                        ? [
                          item.offerFormat ? t(`protocols.${item.offerFormat}`) : null,
                          item.effect ? t(`effect.${item.effect}`) : null,
                          item.scope === "native_global" ? t("scopeNativeGlobal") : null,
                          item.replaces ? t("replaces", { host: item.replaces.host }) : null,
                          item.runningSessions && item.effect === "restart" ? t("runningSessions", { count: item.runningSessions }) : null,
                          item.tooManyModels ? t("tooManyModels", { limit: item.models?.limit ?? 64 }) : null,
                        ].filter(Boolean).join(" · ")
                        : t(`skip.${item.reason ?? "unknown"}`)}
                    </span>
                  </div>
                </label>
              )
            })}
          </div>
        )}
        {running > 0 ? (
          <Field orientation="horizontal">
            <div className="flex-1">
              <FieldLabel htmlFor="model-apply-interrupt">{t("allowInterrupt")}</FieldLabel>
              <FieldDescription>{t("allowInterruptDescription", { count: running })}</FieldDescription>
            </div>
            <Switch id="model-apply-interrupt" checked={allowInterrupt} onCheckedChange={setAllowInterrupt} />
          </Field>
        ) : null}
        {needsGlobal ? (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox className="mt-0.5" checked={confirmGlobal} onCheckedChange={(checked) => setConfirmGlobal(checked === true)} />
            <span>{t("confirmNativeGlobal")}</span>
          </label>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("cancel")}</Button>
          <Button onClick={() => void apply()} disabled={applying || chosen.length === 0 || (needsGlobal && !confirmGlobal)}>
            {applying ? <Spinner /> : null}{t("applyCount", { count: chosen.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DevicesSection({
  token,
  connectors,
  runtimes,
  overview,
  errorText,
}: {
  token: string
  connectors: ConnectorView[]
  runtimes: DeviceRuntimeView[]
  overview: ModelConfigOverview
  errorText: (error: unknown) => string
}) {
  const t = useTranslations("pages.settings.modelConfigs")
  const tStatus = useTranslations("pages.settings.modelConfigs.connectionState")
  const [restoring, setRestoring] = React.useState<string | null>(null)
  const byTarget = new Map(overview.assignments.map((item) => [`${item.connectorId}/${item.runtimeId}`, item]))
  const profileName = (id: string) => overview.profiles.find((profile) => profile.id === id)?.name ?? id

  const restore = async (assignment: ModelAssignment) => {
    const key = `${assignment.connectorId}/${assignment.runtimeId}`
    setRestoring(key)
    try {
      await modelConfigApi.restore(token, assignment, true)
      toast.success(t("restored"))
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setRestoring(null)
    }
  }

  const rows = runtimes.map((runtime) => ({
    runtime,
    assignment: byTarget.get(`${runtime.connectorId}/${runtime.runtimeId}`),
  }))

  return (
    <SettingsSection title={t("devicesTitle")} description={t("devicesDescription")}>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noDevices")}</p>
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {rows.map(({ runtime, assignment }) => {
            const status = assignment?.modelConnectionStatus ?? runtime.modelConnectionStatus
            const key = `${runtime.connectorId}/${runtime.runtimeId}`
            return (
              <div key={key} className="flex flex-wrap items-center gap-3 py-3">
                <div className="flex min-w-0 flex-1 basis-60 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{runtime.name ?? runtime.displayName}</span>
                    <span className="text-muted-foreground">{connectors.find((item) => item.id === runtime.connectorId)?.name}</span>
                    <RuntimeMaturityBadge maturity={runtime.modelConnection?.maturity ?? runtime.maturity} />
                    {runtime.managedBy === "model-config" ? <Badge variant="secondary">{t("managedInstance")}</Badge> : null}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {assignment
                      ? t("assignedProfile", { name: profileName(assignment.profileId) })
                      : t("notAssigned")}
                    {status?.reason ? ` · ${status.reason}` : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {assignment && assignment.status !== "applied" ? (
                    <Badge variant="outline" className={TONE_CLASS[assignmentStatusTone(assignment.status)]}>
                      {t(`assignmentStatus.${assignment.status}`)}
                    </Badge>
                  ) : null}
                  {status ? (
                    <Badge variant="outline" className={TONE_CLASS[connectionStateTone(status.state)]}>
                      {tStatus(status.state)}
                    </Badge>
                  ) : null}
                  {assignment ? (
                    <Button size="sm" variant="ghost" disabled={restoring !== null} onClick={() => void restore(assignment)}>
                      {restoring === `${assignment.connectorId}/${assignment.runtimeId}` ? <Spinner /> : <RotateCcw data-icon="inline-start" />}
                      {t("restore")}
                    </Button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </SettingsSection>
  )
}

function reportOperation(
  operation: ModelOperation,
  t: ReturnType<typeof useTranslations<"pages.settings.modelConfigs">>,
) {
  const applied = operation.results.filter((item) => item.result === "applied").length
  const other = operation.results.length - applied
  if (other === 0) toast.success(t("appliedCount", { count: applied }))
  else toast.warning(t("appliedPartially", { applied, other }))
}
