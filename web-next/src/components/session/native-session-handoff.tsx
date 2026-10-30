"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { findCapability } from "./capabilities"
import { dashboardApi } from "@/features/dashboard/api"
import { workflowApi, type RecoveryRequest } from "@/features/dashboard/runtime-workflows"
import { isApiError } from "@/lib/api/errors"
import type { ProtocolCapabilitySet, SessionRuntimeState, SessionView } from "@/features/dashboard/types"

export function NativeSessionHandoff({ token, session, state, capabilities, onSettled }: {
  token: string; session: SessionView; state: SessionRuntimeState | null;
  capabilities: ProtocolCapabilitySet | null; onSettled: () => Promise<void>;
}) {
  const t = useTranslations("dashboard.session.nativeHistory")
  const recovery = findCapability(capabilities, "session.recover")
  const close = findCapability(capabilities, "session.close")
  const rawMetadata = recovery?.metadata ?? state?.metadata
  const metadata: Record<string, unknown> = rawMetadata && typeof rawMetadata === "object" ? rawMetadata as Record<string, unknown> : {}
  const native = metadata.nativeHistory === true || state?.metadata?.nativeHistory === true
  const [open, setOpen] = React.useState(false)
  const [confirmed, setConfirmed] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [releasing, setReleasing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const pending = React.useRef<RecoveryRequest | null>(null)
  const mounted = React.useRef(true)
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  if (!native) return null
  const canClose = Boolean(close?.supported && close.available && close.allowed)
  const canRecover = Boolean(recovery?.supported && recovery.available && (recovery.allowed || recovery.unavailableReason === "session_not_taken_over"))
  const generation = String(state?.metadata?.ownerGeneration ?? metadata.ownerGeneration ?? "")
  const revision = String(state?.metadata?.sourceRevision ?? metadata.sourceRevision ?? "")

  async function resume() {
    if (busy || (!pending.current && !confirmed)) return
    setOpen(false); setBusy(true); setError(null)
    try {
      if (!pending.current) {
        if (!session.takeover) await dashboardApi.enableTakeover(token, session.id)
        pending.current = { operationId: crypto.randomUUID(), expectedGeneration: generation, sourceRevision: revision, cliExited: true }
      }
      for (let attempt = 0; attempt < 360 && mounted.current; attempt++) {
        const result = await workflowApi.recover(token, session.id, pending.current)
        if (result.phase === "completed") { pending.current = null; await onSettled(); return }
        if (result.phase === "rejected" || result.phase === "failed") {
          pending.current = null
          throw new Error(result.failure?.message ?? t("failed"))
        }
        if (result.phase !== "running") throw new Error(t("unknown"))
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      if (mounted.current) throw new Error(t("unknown"))
    } catch (cause) {
      if (isApiError(cause) && cause.status >= 400 && cause.status < 500) pending.current = null
      if (mounted.current) { setError(cause instanceof Error ? cause.message : t("failed")); await onSettled() }
    } finally { if (mounted.current) setBusy(false) }
  }

  async function release() {
    setBusy(true); setReleasing(true); setError(null)
    try {
      const result = await workflowApi.close(token, session.id, { ownerGeneration: generation, closeOperationId: crypto.randomUUID() })
      if (!result.closed) throw new Error(t("releaseFailed"))
      await onSettled()
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : t("releaseFailed")) }
    finally { if (mounted.current) { setBusy(false); setReleasing(false) } }
  }

  return <div className="mx-auto w-full max-w-3xl px-4 pt-2">
    <Alert>
      <AlertTitle>{busy ? t(releasing ? "releasing" : "preparing") : canClose ? t("active") : t("title")}</AlertTitle>
      <AlertDescription>
        <p role="status">{error ?? (typeof state?.error?.message === "string" ? state.error.message : (canClose ? t("activeHint") : t("browseHint")))}</p>
        {!canRecover && !canClose && typeof metadata.reasonMessage === "string" ? <p>{metadata.reasonMessage}</p> : null}
        <div className="flex flex-wrap gap-2 pt-2">
          {canClose ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void release()}>{t("release")}</Button>
            : <Button size="sm" disabled={busy || (!canRecover && !pending.current) || session.connectorStatus !== "online"}
                onClick={() => pending.current ? void resume() : (setConfirmed(false), setOpen(true))}>
                {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}{pending.current ? t("check") : t("continue")}
              </Button>}
        </div>
      </AlertDescription>
    </Alert>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("continue")}</DialogTitle><DialogDescription>{t("confirmHint")}</DialogDescription></DialogHeader>
        <Field orientation="horizontal"><Checkbox id={`cli-exited-${session.id}`} checked={confirmed} onCheckedChange={value => setConfirmed(value === true)} />
          <FieldLabel htmlFor={`cli-exited-${session.id}`}>{t("cliExited")}</FieldLabel></Field>
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>{t("cancel")}</Button>
          <Button disabled={!confirmed || busy} onClick={() => void resume()}>{t("continue")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}
