"use client"

import { useState } from "react"
import { Lock, Eye, EyeOff, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupButton } from "@/components/ui/input-group"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Separator } from "@/components/ui/separator"
import { AuthShell } from "./auth-shell"
import { useAuth } from "./auth-context"
import { useTranslations } from "next-intl"

type Step = "confirm" | "verify" | "success"

export function OAuthLinkExistingScreen() {
  const { navigate, oauthProviderLabel } = useAuth()
  const t = useTranslations("auth")
  const tCommon = useTranslations("common")
  const [step, setStep] = useState<Step>("confirm")
  const [showPassword, setShowPassword] = useState(false)
  const [password, setPassword] = useState("")

  if (step === "success") {
    return (
      <AuthShell>
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-emerald-500/15">
            <CheckCircle2 className="size-8 text-emerald-500" />
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-bold tracking-tight">{t("oauth.accountLinked")}</h1>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t("oauth.accountLinkedDescription", { provider: oauthProviderLabel ?? "" })}
            </p>
          </div>
          <Button className="mt-4 h-11 w-full font-medium" onClick={() => navigate("app")}>
            {tCommon("continue")}
          </Button>
        </div>
      </AuthShell>
    )
  }

  if (step === "verify") {
    return (
      <AuthShell>
        <div className="flex flex-col items-center gap-3 text-center mb-8">
          <Avatar className="size-16 rounded-full">
            <AvatarImage src="/abstract-pixelated-avatar.png" alt="t4wefan" />
            <AvatarFallback className="rounded-full bg-primary text-primary-foreground">T4</AvatarFallback>
          </Avatar>
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold tracking-tight">{t("oauth.verifyTitle")}</h1>
            <p className="text-sm text-muted-foreground">
              {t("oauth.verifyDescription", { provider: oauthProviderLabel ?? "" })}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="link-password">{t("fields.password")}</Label>
            <InputGroup className="h-11 rounded-lg">
              <InputGroupAddon><Lock className="size-4" /></InputGroupAddon>
              <InputGroupInput
                id="link-password"
                type={showPassword ? "text" : "password"}
                placeholder={t("oauth.passwordPlaceholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="font-mono"
                autoComplete="current-password"
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? t("actions.hidePassword") : t("actions.showPassword")}>
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </div>

          <Button
            className="h-11 w-full font-medium"
            disabled={!password}
            onClick={() => setStep("success")}
          >
            {t("oauth.verifySubmit")}
          </Button>

          <Button variant="outline" className="h-11 w-full" onClick={() => navigate("login")}>
            {t("oauth.back")}
          </Button>
        </div>
      </AuthShell>
    )
  }

  // step === "confirm"
  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-3 text-center mb-8">
        <Avatar className="size-16 rounded-full">
          <AvatarImage src="/abstract-pixelated-avatar.png" alt="t4wefan" />
          <AvatarFallback className="rounded-full bg-primary text-primary-foreground">T4</AvatarFallback>
        </Avatar>
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">{t("oauth.matchTitle")}</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t("oauth.matchDescription", { provider: oauthProviderLabel ?? "" })}
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4 mb-6">
        <div className="flex items-center gap-3">
          <Avatar className="size-10 rounded-full">
            <AvatarImage src="/abstract-pixelated-avatar.png" alt="t4wefan" />
            <AvatarFallback className="rounded-full bg-primary text-primary-foreground text-xs">T4</AvatarFallback>
          </Avatar>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-medium">t4wefan</span>
            <span className="text-xs text-muted-foreground">{t("oauth.accountRoleAdmin")}</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Button className="h-11 w-full font-medium" onClick={() => setStep("verify")}>
          {t("oauth.useMatchedAccountLong")}
        </Button>

        <Separator className="my-1" />

        <Button variant="outline" className="h-11 w-full" onClick={() => navigate("oauth-new-user")}>
          {t("oauth.createNewAccount")}
        </Button>

        <Button variant="ghost" className="h-11 w-full text-muted-foreground" onClick={() => navigate("login")}>
          {t("oauth.back")}
        </Button>
      </div>
    </AuthShell>
  )
}
