"use client"

import * as React from "react"
import { Check, Circle, Link2, RefreshCw, Unlink, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { RuntimeMaturityBadge } from "@/components/runtime-maturity-badge"
import { SettingsSection } from "@/components/settings/settings-section"
import { TokensAccount } from "@/components/settings/tokens-account"
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
import { Field, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import type { DeviceRuntimeView, ModelConfigOverview, QuickSetupProgress } from "@/features/dashboard/types"
import { modelConfigApi, type ModelPreviewTarget } from "@/features/model-config/api"
import { createTokensLinkWindow, openTokensLinkStart } from "@/features/model-config/open-link"
import {
  defaultQuickSelection,
  newQuickCandidates,
  quickSetupPhase,
  quickSetupRunning,
  quickSetupSteps,
  quickTargetKey,
  type QuickStepStatus,
} from "@/features/model-config/presentation"
import { cn } from "@/lib/utils"

type Device = { id: string; name: string }

/**
 * One-click Tokens Anywhere setup: tick the runtimes, confirm once in the
 * browser, and the Server syncs the models and applies them. Progress comes
 * with the snapshot, so it shows on every client.
 */
export function TokensQuickSetup({
  token,
  overview,
  connectors,
  runtimes,
  errorText,
  onChanged,
}: {
  token: string
  overview: ModelConfigOverview
  connectors: Device[]
  runtimes: DeviceRuntimeView[]
  errorText: (error: unknown) => string
  onChanged: () => void
}) {
  const t = useTranslations("pages.settings.modelConfigs")
  const tokens = overview.tokens
  const [candidates, setCandidates] = React.useState<ModelPreviewTarget[] | null>(null)
  const [selected, setSelected] = React.useState<Set<string> | null>(null)
  const [authorizing, setAuthorizing] = React.useState(false)
  const authorizationWindow = React.useRef<Window | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [choosing, setChoosing] = React.useState(false)
  const [confirmUnlink, setConfirmUnlink] = React.useState(false)
  const [allowInterrupt, setAllowInterrupt] = React.useState(false)
  const linked = tokens?.link?.status === "linked"
  const tokensProfile = overview.profiles.find((profile) => profile.source === "tokens" && profile.state === "active")
  const tokenAssignments = overview.assignments.filter((item) => tokensProfile && item.profileId === tokensProfile.id)
  const runtimeKey = runtimes.map((item) => `${quickTargetKey(item)}:${item.status}:${item.configured}`).join("|")

  // Opening the authorization page ends once the link shows up in the snapshot.
  React.useEffect(() => {
    if (linked) {
      authorizationWindow.current?.close()
      authorizationWindow.current = null
      setAuthorizing(false)
    }
  }, [linked])

  React.useEffect(() => () => authorizationWindow.current?.close(), [])

  React.useEffect(() => {
    if (!authorizing) return
    const timer = window.setInterval(() => {
      if (authorizationWindow.current?.closed) {
        authorizationWindow.current = null
        setAuthorizing(false)
      }
    }, 500)
    return () => window.clearInterval(timer)
  }, [authorizing])

  React.useEffect(() => {
    if (!tokens?.available || !token) return
    let cancelled = false
    modelConfigApi.quickSetupCandidates(token)
      .then((response) => { if (!cancelled) setCandidates(response.targets) })
      .catch(() => { if (!cancelled) setCandidates([]) })
    return () => { cancelled = true }
  }, [token, tokens?.available, runtimeKey, tokensProfile?.id])

  if (!tokens?.available) return null

  const deviceName = (connectorId: string) => connectors.find((item) => item.id === connectorId)?.name ?? connectorId
  const runtimeName = (target: { connectorId: string; runtimeId: string }) => {
    const runtime = runtimes.find((item) => quickTargetKey(item) === quickTargetKey(target))
    return runtime?.name ?? runtime?.displayName ?? target.runtimeId
  }
  const assigned = tokenAssignments.map((item) => ({
    ...item,
    runtimeType: runtimes.find((runtime) => quickTargetKey(runtime) === quickTargetKey(item))?.runtimeType,
  }))
  const fresh = candidates ? newQuickCandidates(candidates, assigned) : []
  const phase = quickSetupPhase(tokens, tokenAssignments.length > 0, authorizing)
  const selection = selected ?? (candidates ? defaultQuickSelection(candidates) : new Set<string>())

  const start = async (request?: QuickSetupProgress["request"]) => {
    const chosen = (candidates ?? []).filter((item) => item.decision === "apply" && selection.has(quickTargetKey(item)))
    const payload = request ?? {
      targets: chosen.map(({ connectorId, runtimeId }) => ({ connectorId, runtimeId })),
      confirmNativeGlobal: chosen.some((item) => item.requiresConfirmation),
    }
    if (!payload.targets.length) return
    authorizationWindow.current?.close()
    const popup = linked ? null : createTokensLinkWindow()
    authorizationWindow.current = popup
    setBusy(true)
    try {
      const response = await modelConfigApi.startQuickSetup(token, payload)
      setChoosing(false)
      if (response.startUrl) {
        setAuthorizing(!popup?.closed)
        openTokensLinkStart(response.startUrl, popup)
      } else {
        popup?.close()
        authorizationWindow.current = null
      }
      onChanged()
    } catch (error) {
      popup?.close()
      authorizationWindow.current = null
      setAuthorizing(false)
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const chooseNew = () => {
    setSelected(new Set(fresh.filter((item) => !item.requiresConfirmation).map(quickTargetKey)))
    setChoosing(true)
  }

  const sync = async () => {
    setBusy(true)
    try {
      await modelConfigApi.syncTokens(token)
      toast.success(t("synced"))
      onChanged()
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const unlink = async () => {
    setBusy(true)
    try {
      const result = await modelConfigApi.unlinkTokens(token, allowInterrupt)
      setConfirmUnlink(false)
      const failed = result.results.filter((item) => item.result !== "restored").length
      if (failed) toast.warning(t("unlinkedWithFailures", { count: failed }))
      else toast.success(result.revoked ? t("unlinked") : t("unlinkedNotRevoked"))
      onChanged()
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const startButtons = (
    <>
      <Button
        onClick={() => void start()}
        disabled={busy || !tokens.secretConfigured || !candidates?.some((item) => item.decision === "apply" && selection.has(quickTargetKey(item)))}
      >
        {busy ? <Spinner /> : <Link2 data-icon="inline-start" />}{t("quick.start")}
      </Button>
      {choosing ? <Button variant="ghost" onClick={() => setChoosing(false)}>{t("cancel")}</Button> : null}
    </>
  )
  const choices = (
    <>
      <p className="pb-2 text-xs text-muted-foreground">{t("quick.willConfigure")}</p>
      {candidates === null ? (
        <div className="flex justify-center py-4"><Spinner /></div>
      ) : candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noDevices")}</p>
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {candidates.map((item) => {
            const key = quickTargetKey(item)
            const enabled = item.decision === "apply"
            return (
              <label key={key} className={cn("flex items-start gap-3 py-2.5", !enabled && "opacity-60")}>
                <Checkbox
                  className="mt-0.5"
                  checked={enabled && selection.has(key)}
                  disabled={!enabled}
                  onCheckedChange={(checked) => setSelected(() => {
                    const next = new Set(selection)
                    if (checked === true) next.add(key)
                    else next.delete(key)
                    return next
                  })}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{deviceName(item.connectorId)} · {item.name ?? item.runtimeId}</span>
                    <RuntimeMaturityBadge maturity={item.capabilityMaturity ?? item.maturity} />
                  </div>
                  <span className="text-xs text-muted-foreground">{candidateNote(item, t)}</span>
                </div>
              </label>
            )
          })}
        </div>
      )}
    </>
  )

  const unlinkButton = tokens.link ? (
    <Button size="sm" variant="ghost" onClick={() => setConfirmUnlink(true)} disabled={busy}>
      <Unlink data-icon="inline-start" />{t("unlink")}
    </Button>
  ) : null

  return (
    <>
      {phase === "setup" ? (
        <SettingsSection
          title={t("quick.title")}
          description={tokens.link?.status === "reauth_required" ? t("tokensReauth") : t("quick.description")}
          action={unlinkButton}
          footer={startButtons}
        >
          {choices}
        </SettingsSection>
      ) : phase === "progress" ? (
        <QuickSetupProgressCard
          tokens={tokens}
          authorizing={authorizing}
          busy={busy}
          onRetry={() => void start(tokens.quickSetup?.request)}
          onCancel={() => {
            authorizationWindow.current?.close()
            authorizationWindow.current = null
            setAuthorizing(false)
          }}
        />
      ) : (
        <TokensAccount
          token={token}
          profile={tokensProfile}
          fallbackAccount={tokens.link?.account}
          action={unlinkButton}
          syncing={busy}
          applying={quickSetupRunning(tokens)}
          initialTab={tokenAssignments.length === 0 ? "devices" : "models"}
          onSync={() => void sync()}
          onChanged={onChanged}
          errorText={errorText}
          devices={choosing || tokenAssignments.length === 0 ? (
            <div className="flex flex-col gap-3">
              {choices}
              <div className="flex flex-wrap gap-2">{startButtons}</div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {fresh.length ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-sm">
                  <span>{t("quick.newRuntimes", { count: fresh.length })}</span>
                  <Button size="sm" variant="outline" onClick={chooseNew}>{t("quick.configureNew")}</Button>
                </div>
              ) : null}
              {tokens.link?.relinkSoon ? <p className="text-sm text-amber-700 dark:text-amber-400">{t("relinkSoon")}</p> : null}
              <div className="flex flex-col divide-y divide-border">
                {tokenAssignments.map((item) => (
                  <div key={quickTargetKey(item)} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                    <span>{deviceName(item.connectorId)} · {runtimeName(item)}</span>
                    <span className="text-xs text-muted-foreground">{assignmentNote(item.status, item.createdRuntime, t)}</span>
                  </div>
                ))}
                {(tokens.quickSetup?.results ?? [])
                  .filter((item) => item.result === "skipped" || item.result === "failed")
                  .map((item) => (
                    <div key={`skip:${quickTargetKey(item)}`} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                      <span>{deviceName(item.connectorId)} · {runtimeName(item)}</span>
                      <span className="text-xs text-amber-700 dark:text-amber-400">{reasonText(item.reason, t)}</span>
                    </div>
                  ))}
              </div>
              {(tokens.quickSetup?.results ?? []).some((item) => item.modelsTrimmed) ? (
                <p className="text-xs text-muted-foreground">{t("quick.modelsTrimmed")}</p>
              ) : null}
            </div>
          )}
        />
      )}
      <Dialog open={confirmUnlink} onOpenChange={setConfirmUnlink}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("unlinkTitle")}</DialogTitle>
            <DialogDescription>{t("unlinkDescription", { count: tokenAssignments.length })}</DialogDescription>
          </DialogHeader>
          {tokenAssignments.length > 0 ? (
            <Field orientation="horizontal">
              <FieldLabel htmlFor="tokens-unlink-interrupt">{t("allowInterrupt")}</FieldLabel>
              <Switch id="tokens-unlink-interrupt" checked={allowInterrupt} onCheckedChange={setAllowInterrupt} />
            </Field>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmUnlink(false)}>{t("cancel")}</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void unlink()}>
              {busy ? <Spinner /> : null}{t("unlink")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

type Translate = ReturnType<typeof useTranslations<"pages.settings.modelConfigs">>

function candidateNote(item: ModelPreviewTarget, t: Translate): string {
  if (item.decision !== "apply") return reasonText(item.reason, t)
  if (item.requiresConfirmation) return t("quick.changesOwnSettings")
  if (item.effect === "new_instance") return t("quick.managedInstance")
  if (item.effect === "restart" && item.runningSessions) return t("quick.appliesWhenIdle")
  return t(`effect.${item.effect ?? "restart"}`)
}

function assignmentNote(status: string, createdRuntime: boolean, t: Translate): string {
  if (status === "deferred") return t("quick.appliesWhenIdle")
  const label = t(`assignmentStatus.${status}`)
  return createdRuntime ? `${label}${t("quick.viaManagedInstance")}` : label
}

function reasonText(reason: string | undefined, t: Translate): string {
  if (reason && t.has(`skip.${reason}`)) return t(`skip.${reason}`)
  if (reason && t.has(`errors.${reason}`)) return t(`errors.${reason}`)
  return t("skip.unknown")
}

function QuickSetupProgressCard({
  tokens,
  authorizing,
  busy,
  onRetry,
  onCancel,
}: {
  tokens: NonNullable<ModelConfigOverview["tokens"]>
  authorizing: boolean
  busy: boolean
  onRetry: () => void
  onCancel: () => void
}) {
  const t = useTranslations("pages.settings.modelConfigs")
  const steps = quickSetupSteps(tokens, authorizing)
  const progress = tokens.quickSetup
  const count = progress?.request.targets.length ?? 0
  const failed = progress?.state === "failed"
  const failure = progress?.code
    ? (t.has(`errors.${progress.code}`) ? t(`errors.${progress.code}`) : t("errors.generic"))
    : t("errors.generic")
  const account = tokens.link?.account
  return (
    <SettingsSection
      title={t("quick.title")}
      description={t("quick.inProgress")}
      footer={failed ? (
        <Button onClick={onRetry} disabled={busy}>{busy ? <Spinner /> : <RefreshCw data-icon="inline-start" />}{t("retry")}</Button>
      ) : steps.authorize === "active" ? (
        <Button variant="ghost" onClick={onCancel}>{t("cancel")}</Button>
      ) : null}
    >
      <ol className="flex flex-col gap-3">
        <QuickStep
          status={steps.authorize}
          label={t("quick.stepAuthorize")}
          detail={steps.authorize === "done"
            ? t("tokensLinked", { account: account?.displayName ?? account?.email ?? account?.id ?? "" })
            : t("quick.authorizeHint")}
        />
        <QuickStep
          status={steps.sync}
          label={t("quick.stepSync")}
          detail={steps.sync === "active" ? t("quick.syncing") : steps.sync === "failed" ? failure : undefined}
        />
        <QuickStep
          status={steps.apply}
          label={t("quick.stepApply", { count })}
          detail={steps.apply === "active" ? t("quick.applying") : steps.apply === "failed" ? failure : undefined}
        />
      </ol>
    </SettingsSection>
  )
}

function QuickStep({ status, label, detail }: { status: QuickStepStatus; label: string; detail?: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
        {status === "done" ? <Check className="size-4 text-emerald-600 dark:text-emerald-400" />
          : status === "active" ? <Spinner className="size-4" />
          : status === "failed" ? <X className="size-4 text-destructive" />
          : <Circle className="size-3.5 text-muted-foreground" />}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className={cn("text-sm", status === "pending" && "text-muted-foreground")}>{label}</span>
        {detail ? <span className={cn("text-xs", status === "failed" ? "text-destructive" : "text-muted-foreground")}>{detail}</span> : null}
      </div>
    </li>
  )
}
