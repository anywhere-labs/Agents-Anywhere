"use client"

import { useState } from "react"
import { Lock, User } from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { AuthShell } from "./auth-shell"
import { useAuth } from "./auth-context"
import { useTranslations } from "next-intl"

export function OAuthNewUserScreen() {
  const { cancelOAuth, error, finalizeOAuth, loading, navigate, oauthPending } = useAuth()
  const t = useTranslations("auth")
  const [setLocalPassword, setSetLocalPassword] = useState(false)
  const [userId, setUserId] = useState(oauthPending?.userId ?? "")
  const [password, setPassword] = useState("")

  if (!oauthPending || (oauthPending.status !== "needs_registration" && oauthPending.status !== "needs_password")) {
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

  const normalizedUserId = userId.trim().toLowerCase()
  const fallback = normalizedUserId.slice(0, 2).toUpperCase() || "AA"

  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-3 text-center mb-8">
        <Avatar className="size-16 rounded-full">
          <AvatarFallback className="rounded-full bg-primary text-primary-foreground text-lg">{fallback}</AvatarFallback>
        </Avatar>
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">{t("oauth.createTitle")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("oauth.createDescription")}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="oauth-userid">{t("fields.userId")}</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><User className="size-4" /></InputGroupAddon>
            <Input
              id="oauth-userid"
              value={userId}
              onChange={(event) => setUserId(event.currentTarget.value.replace(/\s/g, ""))}
              className="code-mono h-11 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
              autoComplete="username"
              spellCheck={false}
              required
            />
          </InputGroup>
        </div>

        <div className="flex items-center gap-2.5">
          <Checkbox
            id="set-password"
            checked={setLocalPassword}
            onCheckedChange={(value) => setSetLocalPassword(Boolean(value))}
          />
          <Label htmlFor="set-password" className="cursor-pointer text-sm font-normal">
            {t("oauth.setLocalPassword")}
          </Label>
        </div>

        {setLocalPassword ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="oauth-password">{t("fields.password")}</Label>
            <InputGroup className="h-11 rounded-lg">
              <InputGroupAddon><Lock className="size-4" /></InputGroupAddon>
              <InputGroupInput
                id="oauth-password"
                type="password"
                placeholder={t("register.passwordPlaceholder")}
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && normalizedUserId && (!setLocalPassword || password)) {
                    void finalizeOAuth({ userId: normalizedUserId, password, setPassword: true })
                  }
                }}
                className="code-mono"
                autoComplete="new-password"
              />
            </InputGroup>
          </div>
        ) : null}

        {error ? <p className="text-center text-sm text-destructive">{error}</p> : null}

        <Button
          className="h-11 w-full font-medium"
          disabled={loading || !normalizedUserId || (setLocalPassword && !password)}
          onClick={() => void finalizeOAuth({
            userId: normalizedUserId,
            password: setLocalPassword ? password : undefined,
            setPassword: setLocalPassword,
          })}
        >
          {loading ? t("login.signingIn") : t("oauth.createSubmit")}
        </Button>

        <Button variant="outline" className="h-11 w-full" onClick={cancelOAuth}>
          {t("oauth.back")}
        </Button>
      </div>
    </AuthShell>
  )
}
