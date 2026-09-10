"use client"

import { useState } from "react"
import { Key, User, Lock, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel as Label } from "@/components/ui/field"
import { isValidEmail, isValidDisplayName } from "@/features/auth/account-profile"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupButton } from "@/components/ui/input-group"
import { EmailCodeField, DisplayNameField } from "./account-identity-fields"
import { AuthShell } from "./auth-shell"
import { useAuth } from "./auth-context"
import { useTranslations } from "next-intl"

export function BootstrapScreen() {
  const { register, loading, error, emailVerificationRequired } = useAuth()
  const t = useTranslations("auth")
  const [showPassword, setShowPassword] = useState(false)
  const [setupToken, setSetupToken] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [code, setCode] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const localError = password && confirm && password !== confirm ? t("register.passwordMismatch") : null

  const submit = async () => {
    if (!setupToken.trim() || !isValidEmail(email) || !isValidDisplayName(displayName) || (emailVerificationRequired && code.length !== 6) || !password || password !== confirm) return
    await register({ email, displayName, code, password, setupToken }).catch(() => undefined)
  }

  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-2 text-center mb-8">
        <h1 className="text-2xl font-bold tracking-tight">
          {t("bootstrap.titlePrefix")}{" "}
          <span className="aa-wordmark">Agents Anywhere</span>
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t("bootstrap.description")}
        </p>
      </div>

      <FieldGroup>
        <Field>
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
        </Field>

        <Field>
          <Label htmlFor="bs-email">{t("fields.adminEmail")}</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><User className="size-4" /></InputGroupAddon>
            <InputGroupInput
              id="bs-email"
              value={email}
              onChange={(event) => { setEmail(event.currentTarget.value); setCode("") }}
              placeholder={t("bootstrap.userPlaceholder")}
              type="email"
              autoComplete="email"
              spellCheck={false}
              className="code-mono"
            />
          </InputGroup>
        </Field>

        <DisplayNameField variant="auth" value={displayName} onChange={setDisplayName} />
        {emailVerificationRequired ? <EmailCodeField variant="auth" email={email} value={code} onChange={setCode} setupToken={setupToken} disabled={loading} /> : null}

        <Field>
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
        </Field>

        <Field>
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
        </Field>

        <Button
          className="h-11 w-full font-medium"
          disabled={loading || !setupToken.trim() || !isValidEmail(email) || !isValidDisplayName(displayName) || (emailVerificationRequired && code.length !== 6) || !password || password !== confirm}
          onClick={() => void submit()}
        >
          {loading ? t("bootstrap.submitting") : t("bootstrap.submit")}
        </Button>

        {localError || error ? (
          <p className="text-center text-sm text-destructive">{localError || error}</p>
        ) : null}
      </FieldGroup>
    </AuthShell>
  )
}
