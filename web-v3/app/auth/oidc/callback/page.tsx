"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect, useRef, useState } from "react"

import { useI18n } from "@/components/i18n-provider"
import { FullPageSpinner } from "@/components/spinner"
import { Button } from "@/components/ui/button"
import { completeOidcCallback } from "@/lib/auth/oidc"
import { useWorkbench } from "@/lib/state/workbench-context"

function OidcCallbackInner() {
  const { t } = useI18n()
  const router = useRouter()
  const params = useSearchParams()
  const { saveOidcAccount } = useWorkbench()
  const [error, setError] = useState<string | null>(null)
  const ranRef = useRef(false)

  const errParam = params.get("error")
  const code = params.get("code")
  const state = params.get("state")
  const staticError = errParam
    ? (params.get("error_description") ?? errParam)
    : !code || !state
      ? t("signIn.callbackFailed")
      : null

  useEffect(() => {
    if (staticError || !code || !state || ranRef.current) return
    ranRef.current = true

    ;(async () => {
      try {
        const { session, returnTo } = await completeOidcCallback({ code, state })
        await saveOidcAccount(session)
        router.replace(returnTo || "/")
      } catch (err) {
        setError(err instanceof Error ? err.message : t("signIn.callbackFailed"))
      }
    })()
  }, [code, router, saveOidcAccount, state, staticError, t])

  const visibleError = staticError ?? error
  if (visibleError) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-base font-medium">{t("signIn.callbackFailed")}</p>
        <p className="max-w-md text-sm text-muted-foreground">{visibleError}</p>
        <Button nativeButton={false} render={<Link href="/sign-in" />}>
          {t("signIn.switchToLogin")}
        </Button>
      </div>
    )
  }

  return <FullPageSpinner label={t("signIn.callbackTitle")} />
}

export default function OidcCallbackPage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <OidcCallbackInner />
    </Suspense>
  )
}
