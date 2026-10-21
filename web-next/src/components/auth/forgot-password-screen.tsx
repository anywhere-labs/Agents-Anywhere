"use client"

import { useState } from "react"
import { User, Lock, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel as Label } from "@/components/ui/field"
import { isValidEmail } from "@/features/auth/account-profile"
import { authApi } from "@/features/auth/api"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupButton } from "@/components/ui/input-group"
import { EmailCodeField } from "./account-identity-fields"
import { AuthShell } from "./auth-shell"
import { useAuth } from "./auth-context"
import { useTranslations } from "next-intl"

export function ForgotPasswordScreen() {
  const { navigate, passwordResetEnabled } = useAuth()
  const t = useTranslations("auth")
  const [showPassword, setShowPassword] = useState(false)
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const localError = password && confirm && password !== confirm ? t("register.passwordMismatch") : null
  const ready = isValidEmail(email) && code.length === 6 && Boolean(password) && password === confirm

  const submit = async () => {
    if (!ready || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await authApi.resetPassword({ email, code, newPassword: password })
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("forgotPassword.failed"))
    } finally {
      setSubmitting(false)
    }
  }

  const backToLogin = (
    <p className="text-center text-sm text-muted-foreground">
      <button
        type="button"
        className="font-semibold text-foreground underline-offset-4 hover:underline"
        onClick={() => navigate("login")}
      >
        {t("forgotPassword.backToLogin")}
      </button>
    </p>
  )

  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-2 text-center mb-8">
        <h1 className="text-2xl font-bold tracking-tight">{t("forgotPassword.title")}</h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {done
            ? t("forgotPassword.done")
            : passwordResetEnabled
              ? t("forgotPassword.description")
              : t("login.forgot")}
        </p>
      </div>

      {done || !passwordResetEnabled ? (
        <FieldGroup>
          {done ? (
            <Button className="h-11 w-full font-medium" onClick={() => navigate("login")}>
              {t("forgotPassword.signIn")}
            </Button>
          ) : (
            backToLogin
          )}
        </FieldGroup>
      ) : (
        <FieldGroup>
          <Field>
            <Label htmlFor="reset-email">{t("fields.email")}</Label>
            <InputGroup className="h-11 rounded-lg">
              <InputGroupAddon><User className="size-4" /></InputGroupAddon>
              <InputGroupInput
                id="reset-email"
                value={email}
                onChange={(event) => { setEmail(event.currentTarget.value); setCode("") }}
                placeholder={t("login.userPlaceholder")}
                type="email"
                autoComplete="email"
                spellCheck={false}
                className="code-mono"
              />
            </InputGroup>
          </Field>

          <EmailCodeField
            id="reset-code"
            variant="auth"
            purpose="reset"
            email={email}
            value={code}
            onChange={setCode}
            disabled={submitting}
          />

          <Field>
            <Label htmlFor="reset-password">{t("forgotPassword.newPassword")}</Label>
            <InputGroup className="h-11 rounded-lg">
              <InputGroupAddon><Lock className="size-4" /></InputGroupAddon>
              <InputGroupInput
                id="reset-password"
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
          </Field>

          <Field>
            <Label htmlFor="reset-confirm">{t("fields.confirmPassword")}</Label>
            <InputGroup className="h-11 rounded-lg">
              <InputGroupAddon><Lock className="size-4" /></InputGroupAddon>
              <InputGroupInput
                id="reset-confirm"
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
          </Field>

          <Button
            className="h-11 w-full font-medium"
            disabled={submitting || !ready}
            onClick={() => void submit()}
          >
            {submitting ? t("forgotPassword.submitting") : t("forgotPassword.submit")}
          </Button>

          {localError || error ? (
            <p className="text-center text-sm text-destructive">{localError || error}</p>
          ) : null}

          {backToLogin}
        </FieldGroup>
      )}
    </AuthShell>
  )
}
