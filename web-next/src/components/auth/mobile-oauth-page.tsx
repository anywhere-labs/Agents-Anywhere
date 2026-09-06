"use client"

import * as React from "react"
import { useTranslations } from "next-intl"

import { useRouteSearchParams } from "@/components/hash-route-params"
import { LoadingState } from "@/components/loading-state"
import { Button } from "@/components/ui/button"
import { authApi } from "@/features/auth/api"
import { readNativeOAuthParams, type NativeOAuthKind, type NativeOAuthParams } from "@/features/auth/native-oauth"
import { AuthProvider, useAuth } from "./auth-context"
import { BootstrapScreen } from "./bootstrap-screen"
import { LoginScreen } from "./login-screen"
import { OAuthLinkExistingScreen } from "./oauth-link-existing-screen"
import { OAuthNewUserScreen } from "./oauth-new-user-screen"
import { RegisterScreen } from "./register-screen"

const pluginMessages: Record<string, string> = {
  invalid: '授权链接无效，请回到 DSH 插件重新开始。',
  opening: '正在继续本机设置…',
  title: '连接这台电脑',
  description: '授权 DSH 插件连接你的账号。',
  currentAccount: '当前账号', unknownAccount: '已登录账号',
  continue: '授权并继续', switchAccount: '使用其他账号', cancel: '取消',
}

export function MobileOAuthPage() {
  return (
    <AuthProvider>
      <MobileOAuthFlow />
    </AuthProvider>
  )
}

export function MobileOAuthFlow() {
  return <NativeOAuthFlow kind="mobile" />
}

export function DesktopOAuthFlow() {
  return <NativeOAuthFlow kind="desktop" />
}

export function PluginOAuthFlow() {
  return <NativeOAuthFlow kind="plugin" />
}

function NativeOAuthFlow({ kind }: { kind: NativeOAuthKind }) {
  const mobileT = useTranslations("auth.mobileOAuth")
  const desktopT = useTranslations("auth.desktopOAuth")
  const t = kind === 'plugin' ? (key: string) => pluginMessages[key] ?? key : kind === "desktop" ? desktopT : mobileT
  const params = useRouteSearchParams()
  const { me, screen, loading, isAuthenticated, session, signOut } = useAuth()
  const [error, setError] = React.useState<string | null>(null)
  const [authorizing, setAuthorizing] = React.useState(false)

  const oauthParams = React.useMemo(() => readNativeOAuthParams(params, kind), [kind, params])
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
    return <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6">
      <p role="alert" className="max-w-sm text-sm text-destructive">{error}</p>
      <Button variant="outline" onClick={() => setError(null)}>重试</Button>
    </main>
  }
  if (loading || authorizing) {
    return <LoadingState className="min-h-screen bg-background" label={t("opening")} />
  }
  if (isAuthenticated && accessToken) {
    return (
      <MobileOAuthConsent
        kind={kind}
        userId={me?.displayName || me?.email || ""}
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

function mobileOAuthErrorRedirect(params: NativeOAuthParams, error: string, description: string): string {
  const url = new URL(params.redirect_uri)
  url.searchParams.set("error", error)
  url.searchParams.set("error_description", description)
  if (params.state) url.searchParams.set("state", params.state)
  return url.toString()
}

function MobileOAuthConsent({
  kind,
  userId,
  onCancel,
  onContinue,
  onSwitchAccount,
}: {
  kind: NativeOAuthKind
  userId: string
  onCancel: () => void
  onContinue: () => void
  onSwitchAccount: () => void
}) {
  const mobileT = useTranslations("auth.mobileOAuth")
  const desktopT = useTranslations("auth.desktopOAuth")
  const t = kind === 'plugin' ? (key: string) => pluginMessages[key] ?? key : kind === "desktop" ? desktopT : mobileT
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6">
      <section className="w-full max-w-sm space-y-6 text-center">
        <div className="space-y-2">
          {kind !== "plugin" ? <p className="text-sm font-medium text-muted-foreground">{t("eyebrow")}</p> : null}
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
