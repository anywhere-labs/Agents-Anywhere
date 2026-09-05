"use client"

import { useState } from "react"
import { Globe, User, Lock, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel as Label } from "@/components/ui/field"
import { isValidEmail } from "@/features/auth/account-profile"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupButton } from "@/components/ui/input-group"
import { AuthShell } from "./auth-shell"
import { useAuth } from "./auth-context"
import { useTranslations } from "next-intl"

export function LoginScreen() {
  const { navigate, login, loading, error, oauthEnabled, oauthProviderLabel, registrationOpen, startOAuth } = useAuth()
  const t = useTranslations("auth")
  const [showPassword, setShowPassword] = useState(false)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")

  const submit = async () => {
    if (!isValidEmail(email) || !password) return
    await login({ email, password }).catch(() => undefined)
  }

  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-2 text-center mb-8">
        <h1 className="text-2xl font-bold tracking-tight">
          {t("login.titlePrefix")}{" "}
          <span className="aa-wordmark">Agents Anywhere</span>
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t("login.description")}
        </p>
      </div>

      <FieldGroup>
        <Field>
          <Label htmlFor="login-email">{t("fields.email")}</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><User className="size-4" /></InputGroupAddon>
            <InputGroupInput
              id="login-email"
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
              placeholder={t("login.userPlaceholder")}
              type="email"
              autoComplete="email"
              spellCheck={false}
              className="code-mono"
            />
          </InputGroup>
        </Field>

        <Field>
          <Label htmlFor="login-password">{t("fields.password")}</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><Lock className="size-4" /></InputGroupAddon>
            <InputGroupInput
              id="login-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit()
              }}
              placeholder={t("login.passwordPlaceholder")}
              autoComplete="current-password"
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

        <Button
          className="h-11 w-full font-medium"
          disabled={loading || !isValidEmail(email) || !password}
          onClick={() => void submit()}
        >
          {loading ? t("login.signingIn") : t("login.submitWithEnter")}
        </Button>

        {error ? <p className="text-center text-sm text-destructive">{error}</p> : null}

        {oauthEnabled && oauthProviderLabel ? (
          <Button
            variant="outline"
            className="h-11 w-full gap-2"
            disabled={loading}
            onClick={() => void startOAuth()}
          >
            <Globe className="size-4" />
            {t("login.oauth", { provider: oauthProviderLabel })}
          </Button>
        ) : null}

        {registrationOpen ? (
          <div className="flex flex-col items-center gap-1 text-sm text-muted-foreground">
            <p>
              {t("login.newHere")}{" "}
              <button
                type="button"
                className="font-medium text-foreground underline-offset-4 hover:underline"
                onClick={() => navigate("register")}
              >
                {t("login.createAccount")}
              </button>
            </p>
            <p>{t("login.forgot")}</p>
          </div>
        ) : null}
      </FieldGroup>
    </AuthShell>
  )
}
