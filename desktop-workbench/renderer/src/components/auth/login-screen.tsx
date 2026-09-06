"use client"

import { useState } from "react"
import { LoaderCircle, Server } from "lucide-react"
import { LoginAction } from "./login-action"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { AuthShell } from "./auth-shell"
import { useAuth } from "./auth-context"
import { useTranslations } from "next-intl"

export function LoginScreen() {
  const {
    error,
    desktopOAuthAvailable,
    startDesktopOAuth,
    oauthStatus,
    clearError,
  } = useAuth()
  const t = useTranslations("auth")
  const [showServer, setShowServer] = useState(false)
  const [serverUrl, setServerUrl] = useState("")
  const [loginTarget, setLoginTarget] = useState<"cloud" | "server">("cloud")
  const busy = oauthStatus === "opening"

  const startLogin = async (target: "cloud" | "server") => {
    setLoginTarget(target)
    await startDesktopOAuth(target === "server" ? serverUrl : undefined)
  }

  return (
    <AuthShell>
      <div className="mb-8 flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{t("login.syncTitle")}</h1>
        <p className="text-sm leading-6 text-muted-foreground">{t("login.syncDescription")}</p>
      </div>

      <div className="flex flex-col gap-7">
        <LoginAction
          loading={busy && loginTarget === "cloud"}
          disabled={busy || !desktopOAuthAvailable}
          startLogin={() => startLogin("cloud")}
        />

        {showServer ? (
          <form
            id="desktop-server-login"
            className="flex flex-col gap-8 pt-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (serverUrl.trim() && !busy && desktopOAuthAvailable) void startLogin("server")
            }}
          >
            <FieldSeparator>OR</FieldSeparator>
            <FieldGroup className="gap-4">
              <Field data-invalid={Boolean(error && loginTarget === "server")} data-disabled={busy}>
                <FieldLabel htmlFor="desktop-server-url">{t("login.selfHosted")}</FieldLabel>
                <InputGroup className="h-11 rounded-xl" data-disabled={busy}>
                  <InputGroupAddon className="pl-3"><Server aria-hidden="true" /></InputGroupAddon>
                  <InputGroupInput
                    id="desktop-server-url"
                    type="text"
                    inputMode="url"
                    autoComplete="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    autoFocus
                    value={serverUrl}
                    onChange={(event) => { setServerUrl(event.target.value); clearError() }}
                    placeholder={t("login.serverPlaceholder")}
                    disabled={busy}
                    aria-invalid={Boolean(error && loginTarget === "server")}
                    aria-describedby={error ? "desktop-login-error" : undefined}
                    className="h-full"
                  />
                </InputGroup>
              </Field>
              <Button type="submit" className="h-10 w-full rounded-lg" disabled={busy || !serverUrl.trim() || !desktopOAuthAvailable}>
                {busy && loginTarget === "server" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
                {t(busy && loginTarget === "server" ? "login.connecting" : "login.connectServer")}
              </Button>
            </FieldGroup>
          </form>
        ) : (
          <div className="text-muted-foreground">
            <Button
              variant="ghost"
              className="h-10 w-full rounded-lg"
              disabled={busy}
              aria-expanded={showServer}
              aria-controls="desktop-server-login"
              onClick={() => { setShowServer(true); clearError() }}
            >
              {t("login.selfHosted")}
            </Button>
          </div>
        )}

        {error ? <FieldError id="desktop-login-error">{error}</FieldError> : null}
        {oauthStatus === "waiting" && !error ? <p role="status" className="text-center text-sm text-muted-foreground">{t("login.browserOpened")}</p> : null}
      </div>
    </AuthShell>
  )
}
