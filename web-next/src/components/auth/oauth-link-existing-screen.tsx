"use client"

import { useState } from "react"
import { Eye, EyeOff, Lock } from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { AuthShell } from "./auth-shell"
import { useAuth } from "./auth-context"
import { useTranslations } from "next-intl"

export function OAuthLinkExistingScreen() {
  const { cancelOAuth, error, finalizeOAuth, loading, navigate, oauthPending, oauthProviderLabel } = useAuth()
  const t = useTranslations("auth")
  const [confirmed, setConfirmed] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [password, setPassword] = useState("")

  if (!oauthPending || oauthPending.status !== "needs_password") {
    return (
      <AuthShell>
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-sm text-muted-foreground">{t("errors.oauth")}</p>
          <Button className="h-11 w-full" onClick={() => navigate("login")}>
            {t("oauth.back")}
          </Button>
        </div>
      </AuthShell>
    )
  }

  const userId = oauthPending.userId
  const provider = oauthProviderLabel ?? "OAuth"
  const fallback = userId.slice(0, 2).toUpperCase() || "AA"

  if (!confirmed) {
    return (
      <AuthShell>
        <div className="flex flex-col items-center gap-3 text-center mb-8">
          <Avatar className="size-16 rounded-full">
            <AvatarFallback className="rounded-full bg-primary text-primary-foreground">{fallback}</AvatarFallback>
          </Avatar>
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold tracking-tight">{t("oauth.matchTitle")}</h1>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t("oauth.matchDescriptionPrefix")}{" "}
              <span className="code-mono font-medium text-foreground">{userId}</span>.
            </p>
          </div>
        </div>

        {error ? <p className="mb-4 text-center text-sm text-destructive">{error}</p> : null}

        <div className="flex flex-col gap-3">
          <Button className="h-11 w-full font-medium" onClick={() => setConfirmed(true)}>
            {t("oauth.useMatchedAccount")}
          </Button>
          <Button variant="outline" className="h-11 w-full" onClick={() => navigate("oauth-new-user")}>
            {t("oauth.useAnotherUser")}
          </Button>
          <Button variant="ghost" className="h-11 w-full text-muted-foreground" onClick={cancelOAuth}>
            {t("oauth.back")}
          </Button>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-3 text-center mb-8">
        <Avatar className="size-16 rounded-full">
          <AvatarFallback className="rounded-full bg-primary text-primary-foreground">{fallback}</AvatarFallback>
        </Avatar>
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">{t("oauth.confirmTitle")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("oauth.verifyDescription", { provider })}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="oauth-link-password">{t("fields.password")}</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><Lock className="size-4" /></InputGroupAddon>
            <InputGroupInput
              id="oauth-link-password"
              type={showPassword ? "text" : "password"}
              placeholder={t("oauth.passwordPlaceholder")}
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && password) {
                  void finalizeOAuth({ userId, password })
                }
              }}
              className="code-mono"
              autoComplete="current-password"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? t("actions.hidePassword") : t("actions.showPassword")}>
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>

        {error ? <p className="text-center text-sm text-destructive">{error}</p> : null}

        <Button
          className="h-11 w-full font-medium"
          disabled={loading || !password}
          onClick={() => void finalizeOAuth({ userId, password })}
        >
          {loading ? t("login.signingIn") : t("oauth.linkSubmit")}
        </Button>
        <Button variant="outline" className="h-11 w-full" onClick={() => setConfirmed(false)}>
          {t("oauth.useAnotherUser")}
        </Button>
        <Button variant="ghost" className="h-11 w-full text-muted-foreground" onClick={cancelOAuth}>
          {t("oauth.back")}
        </Button>
      </div>
    </AuthShell>
  )
}
