"use client"

import { LoginAction } from "@desktop-login-action"
import { AuthShell } from "./auth-shell"
import { useAuth } from "./auth-context"
import { useTranslations } from "next-intl"

export function LoginScreen() {
  const {
    loading,
    error,
    desktopOAuthAvailable,
    startDesktopOAuth,
  } = useAuth()
  const t = useTranslations("auth")

  return (
    <AuthShell>
      <div className="mb-8 flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-bold tracking-tight">
          {t("login.titlePrefix")} {" "}
          <span className="aa-wordmark">Agents Anywhere</span>
        </h1>
      </div>

      <div className="flex flex-col gap-5">
        {desktopOAuthAvailable ? (
          <LoginAction loading={loading} startLogin={startDesktopOAuth} />
        ) : null}

        {error ? <p className="text-center text-sm text-destructive">{error}</p> : null}
      </div>
    </AuthShell>
  )
}
