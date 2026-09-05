"use client"

import { useState } from "react"
import { User, Lock, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel as Label } from "@/components/ui/field"
import { isValidEmail, isValidDisplayName } from "@/features/auth/account-profile"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupButton } from "@/components/ui/input-group"
import { EmailCodeField, DisplayNameField } from "./account-identity-fields"
import { AuthShell } from "./auth-shell"
import { useAuth } from "./auth-context"
import { useTranslations } from "next-intl"

export function RegisterScreen() {
  const { navigate, register, loading, error, emailVerificationRequired } = useAuth()
  const t = useTranslations("auth")
  const [showPassword, setShowPassword] = useState(false)
  const [displayName, setDisplayName] = useState("")
  const [code, setCode] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const localError = password && confirm && password !== confirm ? t("register.passwordMismatch") : null

  const submit = async () => {
    if (!isValidEmail(email) || !isValidDisplayName(displayName) || (emailVerificationRequired && code.length !== 6) || !password || password !== confirm) return
    await register({ email, displayName, code, password }).catch(() => undefined)
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

      <FieldGroup>
        <Field>
          <Label htmlFor="reg-email">{t("fields.email")}</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><User className="size-4" /></InputGroupAddon>
            <InputGroupInput
              id="reg-email"
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

        <DisplayNameField variant="auth" value={displayName} onChange={setDisplayName} />
        {emailVerificationRequired ? <EmailCodeField variant="auth" email={email} value={code} onChange={setCode} disabled={loading} /> : null}

        <Field>
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
        </Field>

        <Field>
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
        </Field>

        <Button
          variant="outline"
          className="h-11 w-full font-medium"
          disabled={loading || !isValidEmail(email) || !isValidDisplayName(displayName) || (emailVerificationRequired && code.length !== 6) || !password || password !== confirm}
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
      </FieldGroup>
    </AuthShell>
  )
}
