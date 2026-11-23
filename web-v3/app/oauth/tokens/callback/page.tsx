"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import { FullPageSpinner } from "@/components/spinner"
import { Button } from "@/components/ui/button"
import { completeTokensCallback } from "@/lib/assistant/tokens"
import { useAssistant } from "@/lib/state/assistant-context"
import { useWorkbench } from "@/lib/state/workbench-context"

function TokensCallbackInner() {
  const { t } = useI18n()
  const router = useRouter()
  const params = useSearchParams()
  const { ready, activeAccount, getFreshAccessToken } = useWorkbench()
  const { refreshTokens } = useAssistant()
  const [error, setError] = useState<string | null>(null)
  const ranRef = useRef(false)

  const errParam = params.get("error")
  const code = params.get("code")
  const state = params.get("state")
  const iss = params.get("iss")
  const staticError = !ready
    ? null
    : !activeAccount
      ? "Please sign in to Agents Anywhere before connecting Tokens."
      : errParam
        ? (params.get("error_description") ?? errParam)
        : !code || !state
          ? "Missing authorization code or state from Tokens callback."
          : null

  useEffect(() => {
    if (!ready || !activeAccount || staticError || !code || !state || ranRef.current) return
    ranRef.current = true

    ;(async () => {
      try {
        const userAccessToken = await getFreshAccessToken()
        const res = await completeTokensCallback({
          code,
          state,
          iss,
          serverUrl: activeAccount.serverUrl,
          userAccessToken,
        })
        await refreshTokens()
        toast.success(t("assistant.tokensConnected"))
        router.replace(res.returnTo || "/assistant")
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [ready, activeAccount, code, state, iss, staticError, getFreshAccessToken, refreshTokens, router, t])

  const visibleError = staticError ?? error
  if (visibleError) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-base font-medium">Tokens connection failed</p>
        <p className="max-w-md text-sm text-muted-foreground">{visibleError}</p>
        <Button nativeButton={false} render={<Link href="/assistant?tab=config" />}>
          {t("common.back")}
        </Button>
      </div>
    )
  }

  return <FullPageSpinner label={t("common.loading")} />
}

export default function TokensCallbackPage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <TokensCallbackInner />
    </Suspense>
  )
}
