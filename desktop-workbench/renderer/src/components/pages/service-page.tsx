"use client"

import * as React from "react"
import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  RefreshCw,
  Server,
  ShieldCheck,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { getDesktopServerConnection } from "@/features/desktop/server-connection"
import { toast } from "sonner"
import { copyText } from "@/lib/clipboard"
import { servicePageKey, type AdminServiceSection } from "@/features/admin/navigation"

import { useAuth } from "@/components/auth/auth-context"
import { PageHeader } from "@/components/pages/page-header"
import { ServiceEmailCard } from "@/components/pages/service-email-card"
import { LoadingState } from "@/components/loading-state"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { authApi } from "@/features/auth/api"
import { API_NAMESPACE } from "@/lib/api/client"
import type {
  InstanceSettings,
  OAuthProviderConfig,
  OAuthProviderConfigUpdate,
  ServiceInfo,
} from "@/features/auth/types"
import { cn } from "@/lib/utils"

type OAuthTemplateKey = "custom" | "github" | "gitlab" | "google"

type OAuthTemplate = {
  key: OAuthTemplateKey
  label: string
  defaultBaseUrl: string
  apply: (baseUrl: string) => Partial<OAuthProviderConfigUpdate>
}

type CopyKey =
  | "endpoint"
  | "database"
  | "webCallback"
  | "mobileCallback"
  | "mobileClient"
  | "desktopCallback"
  | "desktopClient"

const MOBILE_CLIENT_ID = "agents-anywhere-mobile"
const MOBILE_CALLBACK = "agents-anywhere://oauth/callback"
const DESKTOP_CLIENT_ID = "agents-anywhere-desktop"
const DESKTOP_CALLBACK = "agents-anywhere-desktop://oauth/callback"

function formatUptime(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rem = minutes % 60
    return rem ? `${hours}h ${rem}m` : `${hours}h`
  }
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours ? `${days}d ${remHours}h` : `${days}d`
}

function browserPublicUrl(fallback: string): string {
  const publicUrl = getDesktopServerConnection()?.oauthWebOrigin
  if (publicUrl) return publicUrl
  if (typeof window === "undefined") return fallback
  return window.location.origin.replace(/\/$/, "") || fallback
}

function webOAuthRedirectUrl(publicUrl: string): string {
  // The Server mounts the upstream OAuth callback under the API namespace.
  return `${publicUrl.replace(/\/$/, "")}${API_NAMESPACE}/auth/oauth/callback`
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

function oauthDraftFromConfig(config: OAuthProviderConfig | null): OAuthProviderConfigUpdate {
  return {
    enabled: config?.enabled ?? false,
    provider: config?.provider ?? "oidc",
    label: config?.label ?? "OAuth",
    authorizeUrl: config?.authorizeUrl ?? "",
    tokenUrl: config?.tokenUrl ?? "",
    userInfoUrl: config?.userInfoUrl ?? "",
    clientId: config?.clientId ?? "",
    clientSecret: "",
    scopes: config?.scopes ?? "openid profile email",
    usernameClaim: config?.usernameClaim ?? "preferred_username",
    subjectClaim: config?.subjectClaim ?? "sub",
    emailClaim: config?.emailClaim ?? "email",
    nameClaim: config?.nameClaim ?? "name",
  }
}

function oauthUpdatePayload(draft: OAuthProviderConfigUpdate): OAuthProviderConfigUpdate {
  const trimmedSecret = draft.clientSecret?.trim()
  const { clientSecret: _clientSecret, ...rest } = draft
  return trimmedSecret ? { ...rest, clientSecret: trimmedSecret } : rest
}

const oauthTemplates: Record<OAuthTemplateKey, OAuthTemplate> = {
  custom: {
    key: "custom",
    label: "Custom",
    defaultBaseUrl: "",
    apply: () => ({}),
  },
  github: {
    key: "github",
    label: "GitHub",
    defaultBaseUrl: "https://github.com",
    apply: (baseUrl) => {
      const root = normalizeBaseUrl(baseUrl || "https://github.com")
      return {
        provider: "github",
        label: "GitHub",
        authorizeUrl: `${root}/login/oauth/authorize`,
        tokenUrl: `${root}/login/oauth/access_token`,
        userInfoUrl: "https://api.github.com/user",
        scopes: "read:user user:email",
        usernameClaim: "login",
        subjectClaim: "id",
        emailClaim: "email",
        nameClaim: "name",
      }
    },
  },
  gitlab: {
    key: "gitlab",
    label: "GitLab",
    defaultBaseUrl: "https://gitlab.com",
    apply: (baseUrl) => {
      const root = normalizeBaseUrl(baseUrl || "https://gitlab.com")
      return {
        provider: "gitlab",
        label: "GitLab",
        authorizeUrl: `${root}/oauth/authorize`,
        tokenUrl: `${root}/oauth/token`,
        userInfoUrl: `${root}/oauth/userinfo`,
        scopes: "openid profile email",
        usernameClaim: "nickname",
        subjectClaim: "sub",
        emailClaim: "email",
        nameClaim: "name",
      }
    },
  },
  google: {
    key: "google",
    label: "Google",
    defaultBaseUrl: "https://accounts.google.com",
    apply: (baseUrl) => {
      const root = normalizeBaseUrl(baseUrl || "https://accounts.google.com")
      return {
        provider: "google",
        label: "Google",
        authorizeUrl: `${root}/o/oauth2/v2/auth`,
        tokenUrl: "https://oauth2.googleapis.com/token",
        userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
        scopes: "openid profile email",
        usernameClaim: "email",
        subjectClaim: "sub",
        emailClaim: "email",
        nameClaim: "name",
      }
    },
  },
}

export function ServicePage({ section }: { section: AdminServiceSection }) {
  const page = servicePageKey(section)
  const { session, me } = useAuth()
  const t = useTranslations("pages.service")
  const tCommon = useTranslations("common")
  const [serviceInfo, setServiceInfo] = React.useState<ServiceInfo | null>(null)
  const [settings, setSettings] = React.useState<InstanceSettings | null>(null)
  const [oauthDraft, setOauthDraft] = React.useState<OAuthProviderConfigUpdate>(() => oauthDraftFromConfig(null))
  const [oauthTemplate, setOauthTemplate] = React.useState<OAuthTemplateKey>("custom")
  const [oauthBaseUrl, setOauthBaseUrl] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [togglePending, setTogglePending] = React.useState<string | null>(null)
  const [oauthSaving, setOauthSaving] = React.useState(false)
  const [copied, setCopied] = React.useState<CopyKey | null>(null)
  const isAdmin = me?.role === "admin"

  const load = React.useCallback(() => {
    if (!session?.accessToken) {
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      authApi.getServiceInfo(session.accessToken),
      authApi.getSettings(session.accessToken),
    ])
      .then(([info, nextSettings]) => {
        if (cancelled) return
        setServiceInfo(info)
        setSettings(nextSettings)
        setOauthDraft(oauthDraftFromConfig(nextSettings.oauth))
        setOauthTemplate("custom")
        setOauthBaseUrl("")
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t("loadFailed"))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [session?.accessToken, t])

  React.useEffect(() => load(), [load])

  const copy = React.useCallback(async (key: CopyKey, value: string) => {
    setCopied(null)
    try {
      await copyText(value)
      setCopied(key)
      window.setTimeout(() => setCopied(null), 1200)
    } catch {
      toast.error(tCommon("copyFailed"))
    }
  }, [tCommon])

  const updateOAuthDraft = React.useCallback((patch: Partial<OAuthProviderConfigUpdate>) => {
    setOauthDraft((current) => ({ ...current, ...patch }))
  }, [])

  const applyOAuthTemplate = React.useCallback(
    (key: OAuthTemplateKey, baseUrl?: string) => {
      setOauthTemplate(key)
      const template = oauthTemplates[key]
      const nextBaseUrl = baseUrl ?? (key === "custom" ? oauthBaseUrl : template.defaultBaseUrl)
      setOauthBaseUrl(nextBaseUrl)
      if (key !== "custom") updateOAuthDraft(template.apply(nextBaseUrl))
    },
    [oauthBaseUrl, updateOAuthDraft],
  )

  const updateOAuthBaseUrl = React.useCallback(
    (nextBaseUrl: string) => {
      setOauthBaseUrl(nextBaseUrl)
      if (oauthTemplate !== "custom") {
        updateOAuthDraft(oauthTemplates[oauthTemplate].apply(nextBaseUrl))
      }
    },
    [oauthTemplate, updateOAuthDraft],
  )

  const handleSettingToggle = React.useCallback(
    async (key: "registrationOpen" | "oauthRegistrationOpen" | "passwordResetEnabled", value: boolean) => {
      if (!settings || !session?.accessToken || togglePending) return
      const previous = settings
      setTogglePending(key)
      setError(null)
      setSettings({ ...settings, [key]: value })
      try {
        setSettings(await authApi.updateSettings(session.accessToken, { [key]: value }))
      } catch (err) {
        setSettings(previous)
        toast.error(err instanceof Error ? err.message : t("updateFailed"))
      } finally {
        setTogglePending(null)
      }
    },
    [session?.accessToken, settings, t, togglePending],
  )

  const saveOAuthProvider = React.useCallback(async () => {
    if (!settings || !session?.accessToken || oauthSaving) return
    setOauthSaving(true)
    setError(null)
    try {
      const updated = await authApi.updateSettings(session.accessToken, {
        oauth: oauthUpdatePayload(oauthDraft),
      })
      setSettings(updated)
      setOauthDraft(oauthDraftFromConfig(updated.oauth))
      setOauthTemplate("custom")
      setOauthBaseUrl("")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("oauthUpdateFailed"))
    } finally {
      setOauthSaving(false)
    }
  }, [oauthDraft, oauthSaving, session?.accessToken, settings, t])

  if (loading) return <LoadingState className="h-full" />

  if (error && (!serviceInfo || !settings)) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-sm text-destructive">
        {error}
      </div>
    )
  }

  if (!serviceInfo || !settings) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-sm text-muted-foreground">
        {t("unavailable")}
      </div>
    )
  }

  const publicUrl = browserPublicUrl(serviceInfo.endpoint)

  return (
    <ScrollArea className="@container/page h-full w-full bg-background">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 pb-16 pt-14 @min-[68rem]/page:pt-8">
        <PageHeader title={t(`sections.${page}.title`)} description={t(`sections.${page}.description`)}>
          <Button type="button" variant="outline" onClick={() => load()} disabled={loading}>
            <RefreshCw data-icon="inline-start" />
            {t("refresh")}
          </Button>
        </PageHeader>

        {page === "general" ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("access")}</CardTitle>
              <CardDescription>{t("accessDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <SettingSwitchField
                  label={t("openRegistration")}
                  description={t("openRegistrationDescription")}
                  checked={settings.registrationOpen}
                  disabled={!isAdmin || togglePending === "registrationOpen"}
                  pending={togglePending === "registrationOpen"}
                  onCheckedChange={(value) => void handleSettingToggle("registrationOpen", value)}
                />
                <SettingSwitchField
                  label={t("oauthRegistration")}
                  description={t("oauthRegistrationDescription")}
                  checked={settings.oauthRegistrationOpen}
                  disabled={!isAdmin || togglePending === "oauthRegistrationOpen"}
                  pending={togglePending === "oauthRegistrationOpen"}
                  onCheckedChange={(value) => void handleSettingToggle("oauthRegistrationOpen", value)}
                />
                <SettingSwitchField
                  label={t("passwordReset")}
                  description={settings.email.enabled ? t("passwordResetDescription") : t("passwordResetNeedsEmail")}
                  checked={settings.passwordResetEnabled === true}
                  disabled={!isAdmin || togglePending === "passwordResetEnabled"}
                  pending={togglePending === "passwordResetEnabled"}
                  onCheckedChange={(value) => void handleSettingToggle("passwordResetEnabled", value)}
                />
              </FieldGroup>
            </CardContent>
          </Card>
        ) : page === "auth" ? (
          <>
            <OAuthProviderCard
              redirectUrl={webOAuthRedirectUrl(publicUrl)}
              copied={copied}
              onCopy={copy}
              draft={oauthDraft}
              isExisting={Boolean(settings.oauth)}
              isAdmin={isAdmin}
              saving={oauthSaving}
              template={oauthTemplate}
              baseUrl={oauthBaseUrl}
              onDraftChange={updateOAuthDraft}
              onTemplateChange={applyOAuthTemplate}
              onBaseUrlChange={updateOAuthBaseUrl}
              onReset={() => {
                setOauthDraft(oauthDraftFromConfig(settings.oauth))
                setOauthTemplate("custom")
                setOauthBaseUrl("")
              }}
              onSave={() => void saveOAuthProvider()}
            />
            <FirstPartyClientsCard copied={copied} onCopy={copy} />
          </>
        ) : page === "email" ? (
          <ServiceEmailCard settings={settings.email} token={session?.accessToken ?? ""} isAdmin={isAdmin} onSaved={setSettings} />
        ) : (
          <>
            <ServerCard
              info={serviceInfo}
              publicUrl={publicUrl}
              copied={copied}
              onCopy={copy}
            />
            <AboutCard />
          </>
        )}
      </div>
    </ScrollArea>
  )
}

function CopyButton({
  copied,
  label,
  onClick,
}: {
  copied: boolean
  label: string
  onClick: () => void
}) {
  return (
    <Button type="button" variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
      {copied ? <Check /> : <Copy />}
    </Button>
  )
}

function ServerCard({
  info,
  publicUrl,
  copied,
  onCopy,
}: {
  info: ServiceInfo
  publicUrl: string
  copied: CopyKey | null
  onCopy: (key: CopyKey, value: string) => void
}) {
  const t = useTranslations("pages.service")
  const tCommon = useTranslations("common")

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("server")}</CardTitle>
        <CardDescription>{t("serverDescription")}</CardDescription>
        <CardAction>
          <Server />
        </CardAction>
      </CardHeader>
      <CardContent className="px-0">
        <InfoRow
          label={t("endpoint")}
          value={<code className="code-mono text-sm">{publicUrl}</code>}
          action={
            <CopyButton
              copied={copied === "endpoint"}
              label={tCommon("copy")}
              onClick={() => onCopy("endpoint", publicUrl)}
            />
          }
        />
        <InfoRow label={t("version")} value={<code className="code-mono text-sm">{info.version}</code>} />
        <InfoRow
          label={t("database")}
          value={
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs">
                {info.database}
              </span>
              {info.databasePath && (
                <code className="min-w-0 truncate code-mono text-sm text-muted-foreground">
                  {info.databasePath}
                </code>
              )}
            </div>
          }
          action={
            info.databasePath ? (
              <CopyButton
                copied={copied === "database"}
                label={tCommon("copy")}
                onClick={() => onCopy("database", info.databasePath ?? "")}
              />
            ) : null
          }
        />
        <InfoRow label={t("startedAt")} value={<code className="code-mono text-sm">{info.startedAt}</code>} />
        <InfoRow label={t("uptime")} value={<span>{formatUptime(info.uptimeSeconds)}</span>} last />
      </CardContent>
    </Card>
  )
}

/** A titled run of rows inside a card; groups are divided by the same hairline as rows. */
function InfoGroup({
  title,
  children,
  last,
}: {
  title: string
  children: React.ReactNode
  last?: boolean
}) {
  return (
    <div className={cn(!last && "border-b border-border")}>
      <div className="px-5 pb-1.5 pt-3 text-xs font-medium text-muted-foreground">{title}</div>
      {children}
    </div>
  )
}

function InfoRow({
  label,
  value,
  hint,
  action,
  last,
}: {
  label: string
  value: React.ReactNode
  hint?: string
  action?: React.ReactNode
  last?: boolean
}) {
  return (
    <div className={cn("flex items-center gap-4 px-5 py-3", !last && "border-b border-border")}>
      <div className="w-32 shrink-0 text-sm text-muted-foreground">{label}</div>
      <div className={cn("relative min-w-0 flex-1 text-sm", action && "pr-10")}>
        <div className="no-scrollbar min-w-0 overflow-x-auto overflow-y-hidden whitespace-nowrap">{value}</div>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
        {action ? (
          <div className="absolute inset-y-0 right-0 flex items-center bg-card pl-2 before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-10 before:bg-gradient-to-r before:from-transparent before:to-card">
            {action}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SettingSwitchField({
  label,
  description,
  checked,
  disabled,
  pending,
  onCheckedChange,
}: {
  label: string
  description: string
  checked: boolean
  disabled: boolean
  pending: boolean
  onCheckedChange: (value: boolean) => void
}) {
  return (
    <Field orientation="horizontal" data-disabled={disabled}>
      <FieldContent>
        <FieldTitle>{label}</FieldTitle>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <div className="flex items-center gap-2">
        {pending && <Spinner />}
        <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
      </div>
    </Field>
  )
}

function OAuthProviderCard({
  redirectUrl,
  copied,
  onCopy,
  draft,
  isExisting,
  isAdmin,
  saving,
  template,
  baseUrl,
  onDraftChange,
  onTemplateChange,
  onBaseUrlChange,
  onReset,
  onSave,
}: {
  redirectUrl: string
  copied: CopyKey | null
  onCopy: (key: CopyKey, value: string) => void
  draft: OAuthProviderConfigUpdate
  isExisting: boolean
  isAdmin: boolean
  saving: boolean
  template: OAuthTemplateKey
  baseUrl: string
  onDraftChange: (patch: Partial<OAuthProviderConfigUpdate>) => void
  onTemplateChange: (key: OAuthTemplateKey, baseUrl?: string) => void
  onBaseUrlChange: (value: string) => void
  onReset: () => void
  onSave: () => void
}) {
  const t = useTranslations("pages.service")
  const tCommon = useTranslations("common")
  const disabled = !isAdmin || saving
  const showCustomFields = template === "custom"

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("oauthProvider")}</CardTitle>
        <CardDescription>{t("enableOauthDescription")}</CardDescription>
        <CardAction>
          <KeyRound />
        </CardAction>
      </CardHeader>
      {/* The one value the provider's own console asks for, before anything is filled in here. */}
      <CardContent className="px-0">
        <InfoRow
          label={t("webCallback")}
          value={<code className="code-mono text-sm">{redirectUrl}</code>}
          hint={t("webCallbackHint")}
          action={
            <CopyButton
              copied={copied === "webCallback"}
              label={tCommon("copy")}
              onClick={() => onCopy("webCallback", redirectUrl)}
            />
          }
        />
      </CardContent>
      <CardContent>
        <FieldGroup>
          <Field orientation="horizontal" data-disabled={disabled}>
            <FieldContent>
              <FieldTitle>{t("enableOauth")}</FieldTitle>
              <FieldDescription>{t("enableOauthDescription")}</FieldDescription>
            </FieldContent>
            <Switch
              checked={draft.enabled}
              disabled={disabled}
              onCheckedChange={(value: boolean) => onDraftChange({ enabled: value })}
            />
          </Field>

          <Separator />

          <FieldSet>
            <Field>
              <FieldLabel>{t("template")}</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                spacing={0}
                value={template}
                onValueChange={(value: string) => {
                  if (value) onTemplateChange(value as OAuthTemplateKey)
                }}
                className="flex-wrap"
              >
                {Object.values(oauthTemplates).map((item) => (
                  <ToggleGroupItem key={item.key} value={item.key} disabled={disabled}>
                    {item.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FieldDescription>{t("templateDescription")}</FieldDescription>
            </Field>

            {template !== "custom" && (
              <Field>
                <FieldLabel htmlFor="oauth-base-url">{t("baseUrl")}</FieldLabel>
                <Input
                  id="oauth-base-url"
                  value={baseUrl}
                  disabled={disabled}
                  placeholder={oauthTemplates[template].defaultBaseUrl}
                  onChange={(event) => onBaseUrlChange(event.target.value)}
                />
              </Field>
            )}
          </FieldSet>

          <div className="grid gap-4 md:grid-cols-2">
            {showCustomFields && (
              <>
                <TextField
                  id="oauth-provider"
                  label={t("providerKey")}
                  value={draft.provider}
                  disabled={disabled}
                  placeholder="oidc"
                  onChange={(value) => onDraftChange({ provider: value })}
                />
                <TextField
                  id="oauth-label"
                  label={t("providerLabel")}
                  value={draft.label}
                  disabled={disabled}
                  placeholder="OAuth"
                  onChange={(value) => onDraftChange({ label: value })}
                />
              </>
            )}
            <TextField
              id="oauth-client-id"
              label={t("clientId")}
              value={draft.clientId}
              disabled={disabled}
              className={showCustomFields ? "" : "md:col-span-2"}
              onChange={(value) => onDraftChange({ clientId: value })}
            />
            <TextField
              id="oauth-client-secret"
              label={t("clientSecret")}
              value={draft.clientSecret ?? ""}
              type="password"
              disabled={disabled}
              description={isExisting ? t("clientSecretDescription") : undefined}
              className={showCustomFields ? "" : "md:col-span-2"}
              onChange={(value) => onDraftChange({ clientSecret: value })}
            />
            {showCustomFields && (
              <>
                <TextField
                  id="oauth-authorize-url"
                  label={t("authorizeUrl")}
                  value={draft.authorizeUrl}
                  disabled={disabled}
                  className="md:col-span-2"
                  onChange={(value) => onDraftChange({ authorizeUrl: value })}
                />
                <TextField
                  id="oauth-token-url"
                  label={t("tokenUrl")}
                  value={draft.tokenUrl}
                  disabled={disabled}
                  className="md:col-span-2"
                  onChange={(value) => onDraftChange({ tokenUrl: value })}
                />
                <TextField
                  id="oauth-userinfo-url"
                  label={t("userInfoUrl")}
                  value={draft.userInfoUrl}
                  disabled={disabled}
                  className="md:col-span-2"
                  onChange={(value) => onDraftChange({ userInfoUrl: value })}
                />
              </>
            )}
            <TextField
              id="oauth-scopes"
              label={t("scopes")}
              value={draft.scopes}
              disabled={disabled}
              className="md:col-span-2"
              onChange={(value) => onDraftChange({ scopes: value })}
            />
          </div>

          <FieldSet>
            <FieldLabel>{t("claimMapping")}</FieldLabel>
            <div className="grid gap-4 md:grid-cols-2">
              <TextField
                id="oauth-username-claim"
                label={t("usernameClaim")}
                value={draft.usernameClaim}
                disabled={disabled}
                onChange={(value) => onDraftChange({ usernameClaim: value })}
              />
              <TextField
                id="oauth-subject-claim"
                label={t("subjectClaim")}
                value={draft.subjectClaim}
                disabled={disabled}
                onChange={(value) => onDraftChange({ subjectClaim: value })}
              />
              <TextField
                id="oauth-email-claim"
                label={t("emailClaim")}
                value={draft.emailClaim}
                disabled={disabled}
                onChange={(value) => onDraftChange({ emailClaim: value })}
              />
              <TextField
                id="oauth-name-claim"
                label={t("nameClaim")}
                value={draft.nameClaim}
                disabled={disabled}
                onChange={(value) => onDraftChange({ nameClaim: value })}
              />
            </div>
          </FieldSet>
        </FieldGroup>
      </CardContent>
      <CardFooter className="justify-end gap-2 border-t">
        <Button type="button" variant="outline" onClick={onReset} disabled={disabled}>
          {t("reset")}
        </Button>
        <Button type="button" onClick={onSave} disabled={disabled}>
          {saving && <Spinner data-icon="inline-start" />}
          {saving ? t("saving") : t("saveProvider")}
        </Button>
      </CardFooter>
    </Card>
  )
}

function TextField({
  id,
  label,
  value,
  onChange,
  disabled,
  type = "text",
  placeholder,
  description,
  className,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  disabled: boolean
  type?: "text" | "password"
  placeholder?: string
  description?: string
  className?: string
}) {
  return (
    <Field className={className} data-disabled={disabled}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={type}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  )
}

function FirstPartyClientsCard({
  copied,
  onCopy,
}: {
  copied: CopyKey | null
  onCopy: (key: CopyKey, value: string) => void
}) {
  const t = useTranslations("pages.service")
  const tCommon = useTranslations("common")
  const clients: { key: "mobile" | "desktop"; title: string; id: string; callback: string }[] = [
    { key: "mobile", title: t("mobileClient"), id: MOBILE_CLIENT_ID, callback: MOBILE_CALLBACK },
    { key: "desktop", title: t("desktopClient"), id: DESKTOP_CLIENT_ID, callback: DESKTOP_CALLBACK },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("firstPartyClients")}</CardTitle>
        <CardDescription>{t("firstPartyClientsDescription")}</CardDescription>
        <CardAction>
          <ShieldCheck />
        </CardAction>
      </CardHeader>
      <CardContent className="px-0">
        {clients.map((client, index) => (
          <InfoGroup key={client.key} title={client.title} last={index === clients.length - 1}>
            <InfoRow
              label={t("clientId")}
              value={<code className="code-mono text-sm">{client.id}</code>}
              action={
                <CopyButton
                  copied={copied === `${client.key}Client`}
                  label={tCommon("copy")}
                  onClick={() => onCopy(`${client.key}Client`, client.id)}
                />
              }
            />
            <InfoRow
              label={t("callbackUrl")}
              value={<code className="code-mono text-sm">{client.callback}</code>}
              action={
                <CopyButton
                  copied={copied === `${client.key}Callback`}
                  label={tCommon("copy")}
                  onClick={() => onCopy(`${client.key}Callback`, client.callback)}
                />
              }
              last
            />
          </InfoGroup>
        ))}
      </CardContent>
    </Card>
  )
}

function AboutCard() {
  const t = useTranslations("pages.service")

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("about")}</CardTitle>
        <CardDescription>{t("aboutDescription")}</CardDescription>
        <CardAction>
          <Globe />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <a href="https://github.com/anywhere-labs/Agents-Anywhere" target="_blank" rel="noreferrer">
            <Globe data-icon="inline-start" />
            {t("viewOnGithub")}
            <ExternalLink data-icon="inline-end" />
          </a>
        </Button>
      </CardContent>
    </Card>
  )
}
