"use client"

import { useState } from "react"
import { User, Lock, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupButton } from "@/components/ui/input-group"
import { AuthShell } from "./auth-shell"
import { useAuth } from "./auth-context"
import { useTranslations } from "next-intl"

export function RegisterScreen() {
  const { navigate, register, loading, error } = useAuth()
  const t = useTranslations("auth")
  const [showPassword, setShowPassword] = useState(false)
  const [userId, setUserId] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const localError = password && confirm && password !== confirm ? t("register.passwordMismatch") : null

  const submit = async () => {
    if (!userId.trim() || !password || password !== confirm) return
    await register({ userId, password }).catch(() => undefined)
  }

  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-2 text-center mb-8">
        <h1 className="text-2xl font-bold tracking-tight">{t("register.title")}</h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t("register.descriptionPrefix")}<br />
          <span className="aa-wordmark">Agents Anywhere</span>
          {" "}{t("register.descriptionSuffix")}
        </p>
      </div>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reg-userid">{t("fields.userId")}</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><User className="size-4" /></InputGroupAddon>
            <InputGroupInput
              id="reg-userid"
              value={userId}
              onChange={(event) => setUserId(event.currentTarget.value)}
              placeholder={t("login.userPlaceholder")}
              autoComplete="username"
              spellCheck={false}
              className="code-mono"
            />
          </InputGroup>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reg-password">{t("fields.password")}</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><Lock className="size-4" /></InputGroupAddon>
            <InputGroupInput
              id="reg-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              placeholder={t("register.passwordPlaceholder")}
              autoComplete="new-password"
              spellCheck={false}
              className="code-mono"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? t("actions.hidePassword") : t("actions.showPassword")}>
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reg-confirm">{t("fields.confirmPassword")}</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><Lock className="size-4" /></InputGroupAddon>
            <InputGroupInput
              id="reg-confirm"
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit()
              }}
              placeholder={t("register.confirmPlaceholder")}
              autoComplete="new-password"
              spellCheck={false}
              className="code-mono"
            />
          </InputGroup>
        </div>

        <Button
          variant="outline"
          className="h-11 w-full font-medium"
          disabled={loading || !userId.trim() || !password || password !== confirm}
          onClick={() => void submit()}
        >
          {loading ? t("register.creating") : t("register.submitWithEnter")}
        </Button>

        {localError || error ? (
          <p className="text-center text-sm text-destructive">{localError || error}</p>
        ) : null}

        <p className="text-center text-sm text-muted-foreground">
          {t("register.haveAccount")}{" "}
          <button
            type="button"
            className="font-semibold text-foreground underline-offset-4 hover:underline"
            onClick={() => navigate("login")}
          >
            {t("register.signIn")}
          </button>
        </p>
      </div>
    </AuthShell>
  )
}
