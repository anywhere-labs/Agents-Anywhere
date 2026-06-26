"use client"

import { useState } from "react"
import { Key, User, Lock, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupButton } from "@/components/ui/input-group"
import { AuthShell } from "./auth-shell"
import { useAuth } from "./auth-context"
import { useTranslations } from "next-intl"

export function BootstrapScreen() {
  const { register, loading, error } = useAuth()
  const t = useTranslations("auth")
  const [showPassword, setShowPassword] = useState(false)
  const [setupToken, setSetupToken] = useState("")
  const [userId, setUserId] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const localError = password && confirm && password !== confirm ? t("register.passwordMismatch") : null

  const submit = async () => {
    if (!setupToken.trim() || !userId.trim() || !password || password !== confirm) return
    await register({ userId, password, setupToken }).catch(() => undefined)
  }

  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-2 text-center mb-8">
        <h1 className="text-2xl font-bold tracking-tight">
          {t("bootstrap.titlePrefix")}{" "}
          <span className="font-brand font-medium">Agents Anywhere</span>
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t("bootstrap.description")}
        </p>
      </div>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bs-token">{t("fields.setupToken")}</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><Key className="size-4" /></InputGroupAddon>
            <InputGroupInput
              id="bs-token"
              value={setupToken}
              onChange={(event) => setSetupToken(event.currentTarget.value)}
              placeholder={t("bootstrap.tokenPlaceholder")}
              spellCheck={false}
              className="code-mono"
            />
          </InputGroup>
          <p className="text-xs text-muted-foreground">{t("bootstrap.setupHint")}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bs-userid">{t("fields.adminUserId")}</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><User className="size-4" /></InputGroupAddon>
            <InputGroupInput
              id="bs-userid"
              value={userId}
              onChange={(event) => setUserId(event.currentTarget.value)}
              placeholder={t("bootstrap.userPlaceholder")}
              autoComplete="username"
              spellCheck={false}
              className="code-mono"
            />
          </InputGroup>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bs-password">{t("fields.adminPassword")}</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><Lock className="size-4" /></InputGroupAddon>
            <InputGroupInput
              id="bs-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              placeholder={t("login.passwordPlaceholder")}
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
          <Label htmlFor="bs-confirm">{t("fields.confirmPassword")}</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><Lock className="size-4" /></InputGroupAddon>
            <InputGroupInput
              id="bs-confirm"
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
          className="h-11 w-full font-medium"
          disabled={loading || !setupToken.trim() || !userId.trim() || !password || password !== confirm}
          onClick={() => void submit()}
        >
          {loading ? t("bootstrap.submitting") : t("bootstrap.submit")}
        </Button>

        {localError || error ? (
          <p className="text-center text-sm text-destructive">{localError || error}</p>
        ) : null}
      </div>
    </AuthShell>
  )
}
