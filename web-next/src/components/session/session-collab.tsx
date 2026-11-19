"use client"

// Session page pieces for Agent collaboration: the header badges (who created this session, who supervises it) and,
// for a supervisor session, the 「协作」 sheet listing the sessions it supervises with their controls.

import * as React from "react"
import { CollabReviewProgress } from "@/components/session/collab-review"
import { Bot, Eye, Loader2, Network, Plus, RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useAuth } from "@/components/auth/auth-context"
import { CollabSessionLink, useCollabSessions } from "@/components/session/collab-timeline"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useOptionalWorkspace } from "@/components/workspace-context"
import { useSessionCollab, type SessionCollabController } from "@/features/collab/use-session-collab"
import {
  AUTHORITY_KEYS,
  SESSION_PLACEHOLDER,
  splitAroundPlaceholder,
  SUPERVISION_TRIGGERS,
  collabPanelVisible,
  liveEdges,
  sessionCollabEdges,
  supervisedRows,
  supervisionCandidates,
  supervisionTransitions,
  transitionTarget,
  type AuthorityKey,
  type SessionCollabEdges,
  type SupervisedRow,
  type SupervisionTrigger,
} from "@/features/collab/model"
import { cn } from "@/lib/utils"

type CollabSession = { id: string; connectorId: string; connectorStatus?: string; origin?: unknown; supervisors?: unknown; supervised?: unknown }

function edgesKey(edges: SessionCollabEdges): string {
  return edges.supervised.map((edge) => `${edge.supervisionId}:${edge.state}`).join(",")
}

function stateVariant(state: string): "secondary" | "outline" {
  return state === "active" ? "secondary" : "outline"
}

/** 「由 X 创建」 and 「被 X 监督」 badges for the session header. */
export function SessionCollabBadges({ session }: { session: CollabSession }) {
  const t = useTranslations("collab")
  const sessions = useCollabSessions()
  const edges = React.useMemo(() => sessionCollabEdges(session), [session])
  const supervisors = liveEdges(edges.supervisors)
  if (!edges.origin && supervisors.length === 0) return null
  return (
    <div className="flex min-w-0 shrink items-center gap-1 overflow-hidden" data-slot="session-collab-badges">
      {edges.origin ? (
        <Badge variant="outline" className="min-w-0 max-w-56 gap-1 font-normal" title={t("originTooltip", { title: sessions.title(edges.origin.bySessionId) })}>
          <Bot aria-hidden />
          <CollabBadgeText template="createdBy" sessionId={edges.origin.bySessionId} />
        </Badge>
      ) : null}
      {supervisors.map((edge) => (
        <Badge
          key={edge.supervisionId}
          variant={stateVariant(edge.state)}
          className="min-w-0 max-w-56 gap-1 font-normal"
          title={t("supervisorTooltip", { title: sessions.title(edge.supervisorSessionId) })}
        >
          <Eye aria-hidden />
          <CollabBadgeText template={edge.state === "active" ? "supervisedBy" : "supervisedByState"} sessionId={edge.supervisorSessionId} state={t(`state.${edge.state}`)} />
        </Badge>
      ))}
    </div>
  )
}

function CollabBadgeText({ template, sessionId, state }: { template: "createdBy" | "supervisedBy" | "supervisedByState"; sessionId: string; state?: string }) {
  const t = useTranslations("collab")
  const sessions = useCollabSessions()
  const title = sessions.title(sessionId)
  const parts = splitAroundPlaceholder(t(template, { title: SESSION_PLACEHOLDER, state: state ?? "" }), SESSION_PLACEHOLDER)
  return (
    <span className="flex min-w-0 items-center">
      {parts.map((part, index) =>
        part === null
          ? <CollabSessionLink key={index} sessionId={sessionId} className="font-normal">{title}</CollabSessionLink>
          : <span key={index} className="shrink-0 whitespace-pre">{part}</span>,
      )}
    </span>
  )
}

/** The 「协作」 header button and sheet; shown only when the device offers collaboration or edges exist. */
export function SessionCollabButton({ session }: { session: CollabSession }) {
  const t = useTranslations("collab.panel")
  const { session: auth } = useAuth()
  const token = auth?.accessToken ?? null
  const edges = React.useMemo(() => sessionCollabEdges(session), [session])
  // The device serves `/collab`; an offline device leaves only the edges the Server keeps.
  const online = session.connectorStatus !== "offline"
  const controller = useSessionCollab(token, session.id, { enabled: Boolean(token) && online, refreshKey: `${edgesKey(edges)}:${online}` })
  const [open, setOpen] = React.useState(false)
  const refresh = controller.refresh
  React.useEffect(() => {
    if (!open || !online) return
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [online, open, refresh])
  if (!collabPanelVisible(controller.collab, edges)) return null
  return (
    <>
      <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 font-normal" onClick={() => setOpen(true)} data-slot="session-collab-button">
        <Network className="size-3.5" aria-hidden />
        {t("button")}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t("title")}</SheetTitle>
            <SheetDescription>{t("description")}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
            <SessionCollabPanel session={session} edges={edges} controller={controller} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

export function SessionCollabPanel({
  session,
  edges,
  controller,
}: {
  session: CollabSession
  edges: SessionCollabEdges
  controller: SessionCollabController
}) {
  const t = useTranslations("collab.panel")
  const tCollab = useTranslations("collab")
  const workspace = useOptionalWorkspace()
  const sessions = useCollabSessions()
  const { collab, error, loading } = controller
  const rows = React.useMemo(() => supervisedRows(edges.supervised, collab), [collab, edges.supervised])
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [ending, setEnding] = React.useState<SupervisedRow | null>(null)
  const candidates = React.useMemo(
    () => supervisionCandidates(workspace?.sessions ?? [], session.id, rows),
    [rows, session.id, workspace?.sessions],
  )

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key)
    try {
      await action()
    } catch (failure) {
      toast.error(t("failed", { error: failure instanceof Error ? failure.message : String(failure) }))
    } finally {
      setBusy(null)
    }
  }

  const startSupervision = (targetSessionId: string) => {
    setPickerOpen(false)
    const target = workspace?.sessions.find((item) => item.id === targetSessionId)
    void run(`create:${targetSessionId}`, async () => {
      await controller.createSupervision({ targetSessionId, targetDeviceId: target?.connectorId ?? null })
      toast.success(t("started", { title: sessions.title(targetSessionId) }))
    })
  }

  return (
    <div className="flex flex-col gap-6 text-sm" data-slot="session-collab-panel">
      {collab?.review ? <CollabReviewProgress review={collab.review} panel /> : null}
      <div className="flex flex-col gap-2">
        {error || (!collab && session.connectorStatus === "offline") ? <p className="text-muted-foreground">{t("deviceUnavailable")}</p> : null}
        {collab && !collab.available ? <p className="text-muted-foreground">{t("notAvailable")}</p> : null}
        {collab?.grant ? (
          <p className="text-muted-foreground">
            {t("grant", {
              children: collab.grant.limits.maxActiveChildren,
              depth: collab.grant.limits.maxDepth,
              wakes: collab.grant.limits.wakesPerHour,
            })}
            {collab.grant.crossDevice ? ` ${t("grantCrossDevice")}` : null}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {collab?.available ? (
            <Button size="sm" onClick={() => setPickerOpen(true)} disabled={busy !== null}>
              <Plus data-icon="inline-start" aria-hidden />
              {t("superviseOther")}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => void controller.refresh()} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden /> : <RefreshCw data-icon="inline-start" aria-hidden />}
            {t("refresh")}
          </Button>
        </div>
      </div>

      <section className="flex flex-col gap-2" aria-label={t("supervisedTitle")}>
        <h3 className="text-sm font-semibold">{t("supervisedTitle")}</h3>
        {rows.length === 0 ? <p className="text-muted-foreground">{t("noSupervised")}</p> : null}
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <SupervisedRowCard
              key={row.supervisionId}
              row={row}
              busy={busy}
              onTransition={(transition) => {
                if (transition === "end") {
                  setEnding(row)
                  return
                }
                void run(`${row.supervisionId}:${transition}`, () => controller.updateSupervision(row.supervisionId, { state: transitionTarget(transition) }))
              }}
              onAuthority={(key, value) =>
                void run(`${row.supervisionId}:authority:${key}`, () => controller.updateSupervision(row.supervisionId, { authority: { [key]: value } }))}
              onTriggers={(triggers) =>
                void run(`${row.supervisionId}:triggers`, () => controller.updateSupervision(row.supervisionId, { triggers }))}
            />
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2" aria-label={t("actionsTitle")}>
        <h3 className="text-sm font-semibold">{t("actionsTitle")}</h3>
        {!collab || collab.actions.length === 0 ? <p className="text-muted-foreground">{t("noActions")}</p> : (
          <ul className="flex flex-col divide-y rounded-md border">
            {collab.actions.slice(0, 20).map((action) => (
              <li key={action.actionId} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-xs">
                <span className="font-medium">{tCollab.has(`verbs.${action.verb}`) ? tCollab(`verbs.${action.verb}`) : action.verb}</span>
                {action.targetSessionId ? <CollabSessionLink sessionId={action.targetSessionId} className="max-w-[14rem] font-normal" /> : null}
                <span className={cn("text-muted-foreground", action.outcome === "rejected" && "text-destructive")}>
                  {action.outcome && tCollab.has(`panel.outcome.${action.outcome}`) ? tCollab(`panel.outcome.${action.outcome}`) : action.outcome}
                  {action.errorCode ? ` · ${action.errorCode}` : ""}
                </span>
                {action.at ? <span className="ml-auto text-muted-foreground">{new Date(action.at).toLocaleString()}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <CommandDialog open={pickerOpen} onOpenChange={setPickerOpen} title={t("pickerTitle")} description={t("pickerDescription")}>
        <CommandInput placeholder={t("pickerPlaceholder")} />
        <CommandList>
          <CommandEmpty>{t("pickerEmpty")}</CommandEmpty>
          <CommandGroup heading={t("pickerTitle")}>
            {candidates.map((candidate) => (
              <CommandItem key={candidate.id} value={`${candidate.title ?? ""} ${candidate.id}`} onSelect={() => startSupervision(candidate.id)}>
                <span className="min-w-0 truncate">{sessions.title(candidate.id)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>

      <AlertDialog open={ending !== null} onOpenChange={(value) => !value && setEnding(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("endTitle", { title: ending ? sessions.title(ending.targetSessionId) : "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("endDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const row = ending
                setEnding(null)
                if (row) void run(`${row.supervisionId}:end`, () => controller.updateSupervision(row.supervisionId, { state: "ended" }))
              }}
            >
              {t("end")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function SupervisedRowCard({
  row,
  busy,
  onTransition,
  onAuthority,
  onTriggers,
}: {
  row: SupervisedRow
  busy: string | null
  onTransition: (transition: "pause" | "resume" | "end") => void
  onAuthority: (key: AuthorityKey, value: boolean) => void
  onTriggers: (triggers: SupervisionTrigger[]) => void
}) {
  const t = useTranslations("collab.panel")
  const tCollab = useTranslations("collab")
  const detail = row.detail
  const disabled = busy !== null || row.state === "ended"
  return (
    <li className={cn("flex flex-col gap-3 rounded-lg border p-3", row.state === "ended" && "opacity-70")} data-slot="collab-supervised-row">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <CollabSessionLink sessionId={row.targetSessionId} className="max-w-full" />
        <Badge variant={stateVariant(row.state)} className="font-normal">{tCollab(`state.${row.state}`)}</Badge>
        <span className="text-xs text-muted-foreground">{row.createdBy === "agent" ? t("createdByAgent") : t("createdByHuman")}</span>
      </div>
      {detail?.pausedReason && row.state === "paused" ? <p className="text-xs text-muted-foreground">{t("pausedReason", { reason: detail.pausedReason })}</p> : null}
      {detail?.lastWakeAt ? <p className="text-xs text-muted-foreground">{t("lastWake", { time: new Date(detail.lastWakeAt).toLocaleString() })}</p> : null}
      {supervisionTransitions(row.state).length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {supervisionTransitions(row.state).map((transition) => (
            <Button
              key={transition}
              size="xs"
              variant={transition === "end" ? "outline" : "secondary"}
              disabled={busy !== null}
              onClick={() => onTransition(transition)}
            >
              {busy === `${row.supervisionId}:${transition}` ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden /> : null}
              {t(transition)}
            </Button>
          ))}
        </div>
      ) : null}
      {detail ? (
        <>
          <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
            <legend className="mb-1 text-xs font-medium">{t("authorityTitle")}</legend>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              {AUTHORITY_KEYS.map((key) => (
                <label key={key} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={detail.authority[key]}
                    disabled={disabled}
                    onCheckedChange={(value) => onAuthority(key, value === true)}
                  />
                  {tCollab(`authority.${key}`)}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("authorityHint")}</p>
          </fieldset>
          <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
            <legend className="mb-1 text-xs font-medium">{t("triggersTitle")}</legend>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              {SUPERVISION_TRIGGERS.map((trigger) => (
                <label key={trigger} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={detail.triggers.includes(trigger)}
                    disabled={disabled}
                    onCheckedChange={(value) => {
                      const next = value === true
                        ? SUPERVISION_TRIGGERS.filter((item) => item === trigger || detail.triggers.includes(item))
                        : detail.triggers.filter((item) => item !== trigger)
                      onTriggers(next)
                    }}
                  />
                  {tCollab(`triggers.${trigger}`)}
                </label>
              ))}
            </div>
          </fieldset>
        </>
      ) : row.state !== "ended" ? (
        <p className="text-xs text-muted-foreground">{t("detailUnavailable")}</p>
      ) : null}
    </li>
  )
}
