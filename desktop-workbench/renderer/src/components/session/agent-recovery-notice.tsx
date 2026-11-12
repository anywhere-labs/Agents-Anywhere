"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { dashboardApi } from "@/features/dashboard/api"
import { workflowApi, type RecoveryRequest } from "@/features/dashboard/runtime-workflows"
import type { ProtocolCapabilitySet, SessionRuntimeState, SessionView } from "@/features/dashboard/types"
import { isApiError } from "@/lib/api/errors"
import { runtimeFailureOf, useRuntimeErrorText, type RuntimeFailure } from "@/lib/runtime-error-text"
import { findCapability } from "./capabilities"

/** Resumes a session whose Agent connection was lost. Native history keeps its own handoff. */
export function AgentRecoveryNotice({ token, session, state, capabilities, onSettled }: {
  token: string; session: SessionView; state: SessionRuntimeState | null;
  capabilities: ProtocolCapabilitySet | null; onSettled: () => Promise<void>;
}) {
  const t = useTranslations("dashboard.session.agentRecovery")
  const errorText = useRuntimeErrorText()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<RuntimeFailure | null>(null)
  const pending = React.useRef<RecoveryRequest | null>(null)
  const mounted = React.useRef(true)
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const recovery = findCapability(capabilities, "session.recover")
  const generation = typeof state?.metadata?.ownerGeneration === "string" ? state.metadata.ownerGeneration : ""
  const native = state?.metadata?.nativeHistory === true || (recovery?.metadata as Record<string, unknown> | undefined)?.nativeHistory === true
  const canRecover = Boolean(generation && recovery?.supported && recovery.available
    && (recovery.allowed || recovery.unavailableReason === "session_not_taken_over"))
  if (native || (!canRecover && !busy && !pending.current)) return null

  async function resume() {
    if (busy) return
    setBusy(true); setError(null)
    try {
      if (!pending.current) {
        if (!session.takeover) await dashboardApi.enableTakeover(token, session.id)
        pending.current = { operationId: crypto.randomUUID(), expectedGeneration: generation }
      }
      for (let attempt = 0; attempt < 360 && mounted.current; attempt++) {
        const result = await workflowApi.recover(token, session.id, pending.current)
        if (result.phase === "completed") { pending.current = null; await onSettled(); return }
        if (result.phase === "rejected" || result.phase === "failed") {
          pending.current = null
          throw result.failure ?? { message: t("failed") }
        }
        if (result.phase !== "running") throw { message: t("unknown") }
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      if (mounted.current) throw { message: t("unknown") }
    } catch (cause) {
      if (isApiError(cause) && cause.status >= 400 && cause.status < 500) pending.current = null
      if (mounted.current) { setError(runtimeFailureOf(cause)); await onSettled() }
    } finally { if (mounted.current) setBusy(false) }
  }

  return <div className="mx-auto w-full max-w-3xl px-4 pt-2">
    <Alert>
      <AlertTitle>{busy ? t("preparing") : t("title")}</AlertTitle>
      <AlertDescription>
        <p role="status">{errorText(error, t("hint"))}</p>
        <div className="flex flex-wrap gap-2 pt-2">
          <Button size="sm" disabled={busy || session.connectorStatus !== "online"} onClick={() => void resume()}>
            {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}{pending.current ? t("check") : t("action")}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  </div>
}
