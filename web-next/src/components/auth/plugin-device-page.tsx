"use client"

import * as React from "react"
import { useTranslations } from "next-intl"

import { useRouteSearchParams } from "@/components/hash-route-params"
import { LoadingState } from "@/components/loading-state"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { authApi } from "@/features/auth/api"
import { isApiError } from "@/lib/api"
import { useAuth } from "./auth-context"
import { BootstrapScreen } from "./bootstrap-screen"
import { LoginScreen } from "./login-screen"
import { OAuthLinkExistingScreen } from "./oauth-link-existing-screen"
import { OAuthNewUserScreen } from "./oauth-new-user-screen"
import { RegisterScreen } from "./register-screen"

type DeviceRequest = { clientName: string; expiresAt: string }

export function PluginDeviceFlow() {
  const t = useTranslations("auth.pluginDevice")
  const params = useRouteSearchParams()
  const { me, screen, loading, isAuthenticated, session } = useAuth()
  const accessToken = session?.accessToken ?? null
  // verification_uri_complete prefills the code when the plug-in opened this page.
  const [code, setCode] = React.useState(() => (params.get("user_code") ?? "").toUpperCase())
  const [request, setRequest] = React.useState<DeviceRequest | null>(null)
  const [outcome, setOutcome] = React.useState<"approved" | "denied" | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const submitCode = React.useCallback(async () => {
    const trimmed = code.trim()
    if (!accessToken || !trimmed) return
    setBusy(true)
    setError(null)
    try {
      const found = await authApi.lookupDeviceCode(accessToken, trimmed)
      setRequest({ clientName: found.clientName, expiresAt: found.expiresAt })
    } catch (err) {
      setError(deviceErrorMessage(err, t))
    } finally {
      setBusy(false)
    }
  }, [accessToken, code, t])

  const decide = React.useCallback(
    async (approved: boolean) => {
      const trimmed = code.trim()
      if (!accessToken || !trimmed) return
      setBusy(true)
      setError(null)
      try {
        await authApi.approveDeviceCode(accessToken, trimmed, approved)
        setOutcome(approved ? "approved" : "denied")
      } catch (err) {
        setError(deviceErrorMessage(err, t))
      } finally {
        setBusy(false)
      }
    },
    [accessToken, code, t],
  )

  if (loading) {
    return <LoadingState className="min-h-screen bg-background" />
  }
  if (!isAuthenticated || !accessToken) {
    if (screen === "bootstrap") return <BootstrapScreen />
    if (screen === "register") return <RegisterScreen />
    if (screen === "oauth-new-user") return <OAuthNewUserScreen />
    if (screen === "oauth-link-existing") return <OAuthLinkExistingScreen />
    return <LoginScreen />
  }
  if (outcome) {
    return (
      <PluginDeviceStatus
        title={outcome === "approved" ? t("approvedTitle") : t("deniedTitle")}
        description={outcome === "approved" ? t("approvedDescription") : t("deniedDescription")}
        error={outcome === "denied"}
      />
    )
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6">
      <section className="w-full max-w-sm space-y-6 text-center">
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">{t("eyebrow")}</p>
          <h1 className="text-2xl font-semibold tracking-normal text-foreground">{t("title")}</h1>
          <p className="text-sm leading-6 text-muted-foreground">{t("description")}</p>
        </div>
        {request ? (
          <>
            <div className="space-y-1 rounded-lg border border-border bg-muted/30 px-4 py-3 text-left">
              <p className="text-xs font-medium uppercase text-muted-foreground">{t("device")}</p>
              <p className="mt-1 truncate text-base font-medium text-foreground">{request.clientName}</p>
              <p className="text-xs text-muted-foreground">
                {t("account")}: {me?.displayName || me?.email || t("unknownAccount")}
              </p>
            </div>
            <div className="space-y-3">
              <Button className="h-11 w-full" disabled={busy} onClick={() => void decide(true)}>
                {t("approve")}
              </Button>
              <Button variant="outline" className="h-11 w-full" disabled={busy} onClick={() => void decide(false)}>
                {t("deny")}
              </Button>
              <Button
                variant="ghost"
                className="h-11 w-full text-muted-foreground"
                disabled={busy}
                onClick={() => {
                  setRequest(null)
                  setError(null)
                }}
              >
                {t("changeCode")}
              </Button>
            </div>
          </>
        ) : (
          <form
            className="space-y-3 text-left"
            onSubmit={(event) => {
              event.preventDefault()
              void submitCode()
            }}
          >
            <label className="block text-sm font-medium text-foreground" htmlFor="device-user-code">
              {t("codeLabel")}
            </label>
            <Input
              id="device-user-code"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder={t("codePlaceholder")}
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
            />
            <Button type="submit" className="h-11 w-full" disabled={busy || !code.trim()}>
              {busy ? t("checking") : t("continue")}
            </Button>
          </form>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  )
}

function deviceErrorMessage(error: unknown, t: (key: string) => string): string {
  if (isApiError(error)) {
    // 409 already_handled: this user code was approved/denied before (P5 hardening).
    if (error.status === 409) return t("alreadyHandled")
    if (error.status === 404) return t("invalidCode")
    if (error.status === 429) return t("tooManyAttempts")
    if (error.status === 401) return t("sessionExpired")
    if (error.kind === "network" || error.status === 0) return t("networkError")
  }
  return error instanceof Error ? error.message : t("invalidCode")
}

function PluginDeviceStatus({
  title,
  description,
  error = false,
}: {
  title: string
  description: string
  error?: boolean
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-center">
      <section className="max-w-sm space-y-3">
        <h1 className={error ? "text-lg font-semibold text-destructive" : "text-lg font-semibold text-foreground"}>
          {title}
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">{description}</p>
      </section>
    </main>
  )
}
