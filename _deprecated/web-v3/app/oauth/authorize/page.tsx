"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect, useMemo, useState } from "react"
import { CircleAlertIcon } from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { LanguageButton } from "@/components/language-menu"
import { McpConsentForm } from "@/components/oauth/mcp-consent-form"
import { ResultCard, SignInShell } from "@/components/sign-in/sign-in-shell"
import { FullPageSpinner, Spinner } from "@/components/spinner"
import { Button } from "@/components/ui/button"
import { fetchMcpConsentPreview } from "@/lib/api/control-http"
import { APP_CONFIG } from "@/lib/config"
import type { MessageKey } from "@/lib/i18n"
import {
  CONSENT_PATH,
  buildSignInHref,
  parseAuthorizeQuery,
  type AuthorizeRequest,
} from "@/lib/oauth/consent"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { McpConsentPreview } from "@/lib/types/v3"

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; preview: McpConsentPreview }
  | { status: "error"; message: string }

function ConsentFlow({
  request,
  returnTo,
}: {
  request: AuthorizeRequest
  returnTo: string
}) {
  const { t } = useI18n()
  const router = useRouter()
  const { activeAccount, getFreshAccessToken } = useWorkbench()
  const [state, setState] = useState<PreviewState>({ status: "loading" })
  const serverUrl = activeAccount?.serverUrl ?? ""

  useEffect(() => {
    if (!serverUrl) return
    let cancelled = false
    ;(async () => {
      try {
        const token = await getFreshAccessToken()
        const preview = await fetchMcpConsentPreview(serverUrl, token, {
          clientId: request.clientId,
          redirectUri: request.redirectUri,
          scopes: request.scopes,
        })
        if (!cancelled) setState({ status: "ready", preview })
      } catch (err) {
        if (!cancelled) {
          setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [getFreshAccessToken, request, serverUrl])

  if (!activeAccount || state.status === "loading") {
    return (
      <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        {t("oauth.loading")}
      </div>
    )
  }

  if (state.status === "error") {
    // Never redirect back to the client here: the redirect URI has not been verified.
    return (
      <ResultCard
        icon={CircleAlertIcon}
        tone="destructive"
        title={t("oauth.previewFailedTitle")}
        description={t("oauth.previewFailedDesc", { message: state.message, server: serverUrl })}
      >
        <Button
          variant="outline"
          onClick={() => router.push(buildSignInHref(returnTo, { addAccount: true }))}
        >
          {t("oauth.useAnotherAccount")}
        </Button>
        <Button variant="ghost" nativeButton={false} render={<Link href="/" />}>
          {t("oauth.backToWorkbench")}
        </Button>
      </ResultCard>
    )
  }

  return (
    <McpConsentForm
      request={request}
      preview={state.preview}
      serverUrl={serverUrl}
      accountEmail={activeAccount.user.email ?? activeAccount.user.display_name}
      getToken={getFreshAccessToken}
      onUseAnotherAccount={() => router.push(buildSignInHref(returnTo, { addAccount: true }))}
    />
  )
}

function AuthorizeInner() {
  const { t } = useI18n()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { ready, activeAccount } = useWorkbench()

  const query = searchParams.toString()
  const parsed = useMemo(() => parseAuthorizeQuery(new URLSearchParams(query)), [query])
  const returnTo = query ? `${CONSENT_PATH}?${query}` : CONSENT_PATH

  useEffect(() => {
    if (ready && !activeAccount && parsed.ok) router.replace(buildSignInHref(returnTo))
  }, [activeAccount, parsed.ok, ready, returnTo, router])

  if (!ready || (!activeAccount && parsed.ok)) return <FullPageSpinner label={t("oauth.loading")} />

  return (
    <SignInShell brandName={APP_CONFIG.brandName} homeHref="/" headerEnd={<LanguageButton />}>
      {parsed.ok ? (
        <ConsentFlow
          // Switching accounts restarts the flow with a fresh preview.
          key={`${activeAccount?.accountId ?? ""}:${query}`}
          request={parsed.request}
          returnTo={returnTo}
        />
      ) : (
        <ResultCard
          icon={CircleAlertIcon}
          tone="destructive"
          title={t("oauth.invalidTitle")}
          description={`${t(`oauth.error.${parsed.error}` as MessageKey)} ${t("oauth.invalidDesc")}`}
        />
      )}
    </SignInShell>
  )
}

export default function OAuthAuthorizePage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <AuthorizeInner />
    </Suspense>
  )
}
