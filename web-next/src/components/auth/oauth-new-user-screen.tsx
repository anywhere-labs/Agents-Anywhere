"use client"

import { useState } from "react"
import { Lock, User } from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { EmailCodeField, DisplayNameField } from "./account-identity-fields"
import { isValidEmail, isValidDisplayName } from "@/features/auth/account-profile"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Field, FieldGroup, FieldLabel as Label } from "@/components/ui/field"
import { AuthShell } from "./auth-shell"
import { useAuth } from "./auth-context"
import { useTranslations } from "next-intl"

export function OAuthNewUserScreen() {
  const { cancelOAuth, error, finalizeOAuth, loading, navigate, oauthPending, emailVerificationRequired } = useAuth()
  const t = useTranslations("auth")
  const [setLocalPassword, setSetLocalPassword] = useState(false)
  const [displayName, setDisplayName] = useState(oauthPending?.displayName ?? "")
  const [code, setCode] = useState("")
  const [email, setEmail] = useState(oauthPending?.email ?? "")
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

  const normalizedEmail = email.trim().toLowerCase()
  const fallback = normalizedEmail.slice(0, 2).toUpperCase() || "AA"

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

      <FieldGroup>
        <Field>
          <Label htmlFor="oauth-email">{t("fields.email")}</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><User className="size-4" /></InputGroupAddon>
            <InputGroupInput
              id="oauth-email"
              value={email}
              onChange={(event) => { setEmail(event.currentTarget.value); setCode("") }}
              className="code-mono"
              type="email"
              autoComplete="email"
              spellCheck={false}
              required
            />
          </InputGroup>
        </Field>

        <DisplayNameField variant="auth" value={displayName} onChange={setDisplayName} />
        {emailVerificationRequired ? <EmailCodeField variant="auth" email={email} value={code} onChange={setCode} pendingToken={oauthPending.pendingToken} disabled={loading} /> : null}

        <div className="flex items-center gap-2.5">
          <Checkbox
            id="set-password"
            checked={setLocalPassword}
            onCheckedChange={(value: boolean | "indeterminate") => setSetLocalPassword(Boolean(value))}
          />
          <Label htmlFor="set-password" className="cursor-pointer text-sm font-normal">
            {t("oauth.setLocalPassword")}
          </Label>
        </div>

        {setLocalPassword ? (
          <Field>
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
                  if (event.key === "Enter" && isValidEmail(email) && isValidDisplayName(displayName) && (!emailVerificationRequired || code.length === 6) && password) {
                    void finalizeOAuth({ email: normalizedEmail, displayName, code, password, setPassword: true }).catch(() => undefined)
                  }
                }}
                className="code-mono"
                autoComplete="new-password"
              />
            </InputGroup>
          </Field>
        ) : null}

        {error ? <p className="text-center text-sm text-destructive">{error}</p> : null}

        <Button
          className="h-11 w-full font-medium"
          disabled={loading || !isValidEmail(email) || !isValidDisplayName(displayName) || (emailVerificationRequired && code.length !== 6) || (setLocalPassword && !password)}
          onClick={() => void finalizeOAuth({
            email: normalizedEmail,
            displayName,
            code,
            password: setLocalPassword ? password : undefined,
            setPassword: setLocalPassword,
          }).catch(() => undefined)}
        >
          {loading ? t("login.signingIn") : t("oauth.createSubmit")}
        </Button>

        <Button variant="outline" className="h-11 w-full" onClick={cancelOAuth}>
          {t("oauth.back")}
        </Button>
      </FieldGroup>
    </AuthShell>
  )
}
