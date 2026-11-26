"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect, useState } from "react"
import { ArrowRightIcon, RefreshCwIcon, ServerIcon } from "lucide-react"
import { toast } from "sonner"

import { PasswordInput } from "@/components/auth/password-input"
import { Field, Notice } from "@/components/field"
import { useI18n } from "@/components/i18n-provider"
import { LanguageButton } from "@/components/language-menu"
import { SignInShell, StepHeading } from "@/components/sign-in/sign-in-shell"
import { FullPageSpinner, Spinner } from "@/components/spinner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { fetchAuthConfig, normalizeServerUrl } from "@/lib/api/control-http"
import { startOidcLogin } from "@/lib/auth/oidc"
import { SESSION_EXPIRED_FLAG } from "@/lib/auth/session"
import { APP_CONFIG } from "@/lib/config"
import { safeNextPath } from "@/lib/oauth/consent"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { AuthConfigResponse } from "@/lib/types/v3"

function SignInInner() {
  const { t } = useI18n()
  const router = useRouter()
  const searchParams = useSearchParams()
  const isAddingAccount = searchParams.get("add") === "1"
  // Where to go after signing in, e.g. back to an MCP consent page (`/oauth/authorize?...`).
  const nextPath = safeNextPath(searchParams.get("next")) ?? "/"

  const {
    ready,
    activeAccount,
    preferences,
    signInLocal,
    registerLocal,
  } = useWorkbench()

  const [serverUrlDraft, setServerUrlDraft] = useState<string | null>(null)
  const serverUrl = serverUrlDraft ?? (preferences.defaultServerUrl || normalizeServerUrl())
  const setServerUrl = setServerUrlDraft
  const [config, setConfig] = useState<AuthConfigResponse | null>(null)
  const [checking, setChecking] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const [mode, setMode] = useState<"login" | "register">("login")
  const [email, setEmail] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [password, setPassword] = useState("")
  const [setupToken, setSetupToken] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [showServerInput, setShowServerInput] = useState(false)
  // Sent back here because the server refused the saved session (lib/state/workbench-context.tsx `expireSession`).
  const [sessionExpired, setSessionExpired] = useState(false)

  useEffect(() => {
    let expiredEmail: string | null = null
    try {
      expiredEmail = sessionStorage.getItem(SESSION_EXPIRED_FLAG)
      sessionStorage.removeItem(SESSION_EXPIRED_FLAG)
    } catch {
      return
    }
    if (expiredEmail === null) return
    queueMicrotask(() => {
      setSessionExpired(true)
      if (expiredEmail) setEmail(expiredEmail)
    })
  }, [])

  useEffect(() => {
    if (!ready) return
    if (activeAccount && !isAddingAccount) {
      router.replace(nextPath)
    }
  }, [ready, activeAccount, isAddingAccount, nextPath, router])

  const loadConfig = async (url: string) => {
    if (!url.trim()) return
    setChecking(true)
    setServerError(null)
    try {
      const cfg = await fetchAuthConfig(url)
      setConfig(cfg)
      if (cfg.auth_mode === "local" && cfg.needs_bootstrap) {
        setMode("register")
      }
    } catch (err) {
      setConfig(null)
      setServerError(err instanceof Error ? err.message : t("signIn.serverUnreachable"))
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    if (!ready || !serverUrl) return
    let active = true
    queueMicrotask(() => {
      if (active) void loadConfig(serverUrl)
    })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, serverUrl])

  const handleOidc = async () => {
    if (!config?.oidc) return
    setSubmitting(true)
    try {
      const authorizeUrl = await startOidcLogin({
        serverUrl,
        oidc: config.oidc,
        returnTo: nextPath,
      })
      window.location.assign(authorizeUrl)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  const handleLocalSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password) return
    setSubmitting(true)
    try {
      if (mode === "register") {
        await registerLocal({
          serverUrl,
          email: email.trim(),
          password,
          displayName: displayName.trim() || email.split("@")[0] || "User",
          setupToken: setupToken.trim() || undefined,
        })
      } else {
        await signInLocal({ serverUrl, email: email.trim(), password })
      }
      router.replace(nextPath)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (!ready) return <FullPageSpinner label={t("common.loading")} />

  const title =
    config?.auth_mode === "local" && config.needs_bootstrap
      ? t("signIn.bootstrapTitle")
      : mode === "register"
        ? t("signIn.registerTitle")
        : t("signIn.title")

  return (
    <SignInShell
      brandName={APP_CONFIG.brandName}
      homeHref="/"
      headerEnd={<LanguageButton />}
    >
      <div className="w-full max-w-sm space-y-6">
        <StepHeading title={title} />
        {sessionExpired && <Notice tone="warning">{t("signIn.sessionExpired")}</Notice>}
        {/* Control plane server switcher (subtle disclosure) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 truncate">
              <ServerIcon className="size-3.5 shrink-0" />
              <span className="truncate font-mono">{serverUrl || "/api/control"}</span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setShowServerInput((v) => !v)}
            >
              {t("common.edit")}
            </Button>
          </div>
          {showServerInput && (
            <div className="flex items-center gap-2">
              <Input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder={t("signIn.serverPlaceholder")}
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={() => void loadConfig(serverUrl)}
                aria-label={t("common.refresh")}
              >
                <RefreshCwIcon className="size-3.5" />
              </Button>
            </div>
          )}
        </div>

        {checking ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            <span>{t("signIn.serverChecking")}</span>
          </div>
        ) : serverError ? (
          <div className="rounded-card bg-card p-5 space-y-3 text-center">
            <p className="text-sm text-destructive">{serverError}</p>
            <Button variant="outline" size="sm" onClick={() => void loadConfig(serverUrl)}>
              {t("common.refresh")}
            </Button>
          </div>
        ) : config?.auth_mode === "oidc" && config.oidc ? (
          /* OIDC Client Sign-in (anywhere-auth or third-party OIDC) */
          <div className="space-y-4">
            <p className="text-center text-sm text-muted-foreground">{t("signIn.oidcHint")}</p>
            <Button
              size="lg"
              className="w-full"
              disabled={submitting}
              onClick={() => void handleOidc()}
            >
              {submitting ? (
                <Spinner className="size-4 text-primary-foreground" />
              ) : (
                <>
                  <span>
                    {t("signIn.oidcButton", {
                      provider: config.oauth_provider_label ?? "OIDC",
                    })}
                  </span>
                  <ArrowRightIcon className="size-4" />
                </>
              )}
            </Button>
          </div>
        ) : (
          /* Simple self-hosted password sign-in */
          <form onSubmit={handleLocalSubmit} className="space-y-4">
            <Field label={t("signIn.emailLabel")}>
              <Input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("signIn.emailPlaceholder")}
              />
            </Field>

            {mode === "register" && (
              <Field label={t("signIn.displayNameLabel")}>
                <Input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={t("signIn.displayNamePlaceholder")}
                />
              </Field>
            )}

            <Field label={t("signIn.passwordLabel")}>
              <PasswordInput
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("signIn.passwordPlaceholder")}
              />
            </Field>

            {mode === "register" && config?.needs_bootstrap && (
              <Field label={t("signIn.setupTokenLabel")}>
                <Input
                  value={setupToken}
                  onChange={(e) => setSetupToken(e.target.value)}
                  className="font-mono text-xs"
                />
              </Field>
            )}

            <Button type="submit" size="lg" className="w-full" disabled={submitting}>
              {submitting
                ? t("common.loading")
                : mode === "register"
                  ? t("signIn.registerSubmit")
                  : t("signIn.submit")}
            </Button>

            {config && !config.needs_bootstrap && config.registration_open && (
              <div className="pt-1 text-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setMode((m) => (m === "login" ? "register" : "login"))}
                >
                  {mode === "login" ? t("signIn.switchToRegister") : t("signIn.switchToLogin")}
                </Button>
              </div>
            )}

            <p className="text-center text-xs text-muted-foreground">{t("signIn.localHint")}</p>
          </form>
        )}
      </div>
    </SignInShell>
  )
}

export default function SignInPage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <SignInInner />
    </Suspense>
  )
}
