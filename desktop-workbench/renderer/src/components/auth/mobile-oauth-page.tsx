"use client"

import * as React from "react"
import { useTranslations } from "next-intl"

import { useRouteSearchParams } from "@/components/hash-route-params"
import { LoadingState } from "@/components/loading-state"
import { Button } from "@/components/ui/button"
import { authApi } from "@/features/auth/api"
import { AuthProvider, useAuth } from "./auth-context"
import { BootstrapScreen } from "./bootstrap-screen"
import { LoginScreen } from "./login-screen"
import { OAuthLinkExistingScreen } from "./oauth-link-existing-screen"
import { OAuthNewUserScreen } from "./oauth-new-user-screen"
import { RegisterScreen } from "./register-screen"

type MobileOAuthParams = {
  response_type: string
  client_id: string
  redirect_uri: string
  code_challenge: string
  code_challenge_method: string
  scope: string
  state?: string
}

export function MobileOAuthPage() {
  return (
    <AuthProvider>
      <MobileOAuthFlow />
    </AuthProvider>
  )
}

export function MobileOAuthFlow() {
  const t = useTranslations("auth.mobileOAuth")
  const params = useRouteSearchParams()
  const { me, screen, loading, isAuthenticated, session, signOut } = useAuth()
  const [error, setError] = React.useState<string | null>(null)
  const [authorizing, setAuthorizing] = React.useState(false)

  const oauthParams = React.useMemo(() => readMobileOAuthParams(params), [params])
  const accessToken = session?.accessToken ?? null

  const authorize = React.useCallback(async () => {
    if (!accessToken || !oauthParams) return
    setAuthorizing(true)
    const token = accessToken
    const payload = oauthParams
    setError(null)
    try {
      const result = await authApi.authorizeOAuth(token, payload)
      window.location.assign(result.redirectUrl)
    } catch (err) {
      setAuthorizing(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [accessToken, oauthParams])

  const switchAccount = React.useCallback(() => {
    const mobileOAuthHash = window.location.hash
    signOut()
    window.location.hash = mobileOAuthHash
  }, [signOut])

  const cancel = React.useCallback(() => {
    if (!oauthParams) return
    window.location.assign(mobileOAuthErrorRedirect(oauthParams, "access_denied", "The request was cancelled."))
  }, [oauthParams])

  if (!oauthParams) {
    return <MobileOAuthStatus message={t("invalid")} error />
  }
  if (error) {
    return <MobileOAuthStatus message={error} error />
  }
  if (loading || authorizing) {
    return <LoadingState className="min-h-screen bg-background" label={t("opening")} />
  }
  if (isAuthenticated && accessToken) {
    return (
      <MobileOAuthConsent
        userId={me?.userId ?? ""}
        onCancel={cancel}
        onContinue={() => void authorize()}
        onSwitchAccount={switchAccount}
      />
    )
  }
  if (screen === "bootstrap") return <BootstrapScreen />
  if (screen === "register") return <RegisterScreen />
  if (screen === "oauth-new-user") return <OAuthNewUserScreen />
  if (screen === "oauth-link-existing") return <OAuthLinkExistingScreen />
  return <LoginScreen />
}

function readMobileOAuthParams(params: { get(name: string): string | null }): MobileOAuthParams | null {
  const responseType = params.get("response_type")
  const clientId = params.get("client_id")
  const redirectUri = params.get("redirect_uri")
  const codeChallenge = params.get("code_challenge")
  if (!responseType || !clientId || !redirectUri || !codeChallenge) return null
  return {
    response_type: responseType,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: params.get("code_challenge_method") || "S256",
    scope: params.get("scope") || "",
    state: params.get("state") || undefined,
  }
}

function mobileOAuthErrorRedirect(params: MobileOAuthParams, error: string, description: string): string {
  const url = new URL(params.redirect_uri)
  url.searchParams.set("error", error)
  url.searchParams.set("error_description", description)
  if (params.state) url.searchParams.set("state", params.state)
  return url.toString()
}

function MobileOAuthConsent({
  userId,
  onCancel,
  onContinue,
  onSwitchAccount,
}: {
  userId: string
  onCancel: () => void
  onContinue: () => void
  onSwitchAccount: () => void
}) {
  const t = useTranslations("auth.mobileOAuth")
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6">
      <section className="w-full max-w-sm space-y-6 text-center">
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">{t("eyebrow")}</p>
          <h1 className="text-2xl font-semibold tracking-normal text-foreground">{t("title")}</h1>
          <p className="text-sm leading-6 text-muted-foreground">{t("description")}</p>
        </div>
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-left">
          <p className="text-xs font-medium uppercase text-muted-foreground">{t("currentAccount")}</p>
          <p className="mt-1 truncate text-base font-medium text-foreground">{userId || t("unknownAccount")}</p>
        </div>
        <div className="space-y-3">
          <Button className="h-11 w-full" onClick={onContinue}>
            {t("continue")}
          </Button>
          <Button variant="outline" className="h-11 w-full" onClick={onSwitchAccount}>
            {t("switchAccount")}
          </Button>
          <Button variant="ghost" className="h-11 w-full text-muted-foreground" onClick={onCancel}>
            {t("cancel")}
          </Button>
        </div>
      </section>
    </main>
  )
}

function MobileOAuthStatus({ message, error = false }: { message: string; error?: boolean }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-center">
      <p className={error ? "max-w-sm text-sm text-destructive" : "max-w-sm text-sm text-muted-foreground"}>
        {message}
      </p>
    </main>
  )
}
