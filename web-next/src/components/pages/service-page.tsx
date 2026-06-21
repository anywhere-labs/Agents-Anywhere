"use client"

import { useState, useEffect } from "react"
import { ChevronLeft, Copy, Check } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/components/workspace-context"
import { LoadingState } from "@/components/loading-state"
import { useAuth } from "@/components/auth/auth-context"
import { authApi } from "@/features/auth/api"
import type { InstanceSettings, OAuthProviderConfigUpdate, ServiceInfo } from "@/features/auth/types"
import { useTranslations } from "next-intl"

function formatUptime(seconds: number) {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function CopyButton({ text }: { text: string }) {
  const tCommon = useTranslations("common")
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
      aria-label={tCommon("copy")}
    >
      {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
    </button>
  )
}

function InfoRow({
  label,
  children,
  copyText,
  last,
}: {
  label: string
  children: React.ReactNode
  copyText?: string
  last?: boolean
}) {
  return (
    <div className={cn("flex items-center px-6 py-4", !last && "border-b border-border")}>
      <span className="w-36 shrink-0 text-sm text-muted-foreground">{label}</span>
      <div className="flex flex-1 items-center gap-2">{children}</div>
      {copyText && <CopyButton text={copyText} />}
    </div>
  )
}

function ToggleRow({
  label,
  desc,
  checked,
  onCheckedChange,
  last,
}: {
  label: string
  desc: string
  checked: boolean
  onCheckedChange: (v: boolean) => void
  last?: boolean
}) {
  return (
    <div className={cn("flex items-center justify-between px-6 py-5", !last && "border-b border-border")}>
      <div className="pr-8">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{desc}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

export function ServicePage() {
  const { navigate } = useWorkspace()
  const { session } = useAuth()
  const t = useTranslations("pages.service")
  const tCommon = useTranslations("common")
  const [serviceInfo, setServiceInfo] = useState<ServiceInfo | null>(null)
  const [settings, setSettings] = useState<InstanceSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!session?.accessToken) {
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    Promise.all([authApi.getServiceInfo(session.accessToken), authApi.getSettings(session.accessToken)])
      .then(([info, s]) => {
        if (cancelled) return
        setServiceInfo(info)
        setSettings(s)
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

  const handleSettingToggle = async (patch: Pick<Partial<InstanceSettings>, "registrationOpen" | "oauthRegistrationOpen">) => {
    if (!settings || !session?.accessToken) return
    const optimistic = { ...settings, ...patch }
    setSettings(optimistic)
    try {
      const updated = await authApi.updateSettings(session.accessToken, patch)
      setSettings(updated)
    } catch (err) {
      setSettings(settings)
      setError(err instanceof Error ? err.message : t("updateFailed"))
    }
  }

  const handleOAuthToggle = async (enabled: boolean) => {
    if (!settings?.oauth || !session?.accessToken) return
    const patch: { oauth?: OAuthProviderConfigUpdate } = {
      oauth: { ...settings.oauth, enabled },
    }
    const optimistic = { ...settings, ...patch }
    setSettings(optimistic)
    try {
      const updated = await authApi.updateSettings(session.accessToken, patch)
      setSettings(updated)
    } catch (err) {
      setSettings(settings)
      setError(err instanceof Error ? err.message : t("oauthUpdateFailed"))
    }
  }

  if (loading) {
    return (
      <LoadingState className="h-full" />
    )
  }

  if (error || !serviceInfo || !settings) {
    return <div className="flex h-full items-center justify-center text-sm text-destructive">{error ?? t("unavailable")}</div>
  }

  return (
    <ScrollArea className="h-full bg-background">
      <div className="mx-auto w-full max-w-3xl px-8 pt-8 pb-16">
        <button
          type="button"
          onClick={() => navigate("home")}
          className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          {tCommon("back")}
        </button>

        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("description")}
        </p>

        <div className="mt-6 space-y-4">
          {/* Server info */}
          <section className="rounded-xl border border-border bg-card">
            <div className="px-6 py-4">
              <h2 className="text-sm font-semibold">{t("server")}</h2>
            </div>
            <Separator />
            <InfoRow label={t("endpoint")} copyText={serviceInfo.endpoint}>
              <span className="font-mono text-sm">{serviceInfo.endpoint}</span>
            </InfoRow>
            <InfoRow label={t("version")}>
              <span className="font-mono text-sm">{serviceInfo.version}</span>
            </InfoRow>
            <InfoRow
              label={t("database")}
              copyText={serviceInfo.databasePath ?? serviceInfo.database}
            >
              <span className="rounded border border-border bg-muted/40 px-2 py-0.5 font-mono text-xs">
                {serviceInfo.database}
              </span>
              {serviceInfo.databasePath && (
                <span className="font-mono text-sm text-muted-foreground">
                  {serviceInfo.databasePath}
                </span>
              )}
            </InfoRow>
            <InfoRow label={t("uptime")} last>
              <span className="font-mono text-sm">{formatUptime(serviceInfo.uptimeSeconds)}</span>
            </InfoRow>
          </section>

          {/* Access */}
          <section className="rounded-xl border border-border bg-card">
            <div className="px-6 py-4">
              <h2 className="text-sm font-semibold">{t("access")}</h2>
            </div>
            <Separator />
            <ToggleRow
              label={t("openRegistration")}
              desc={t("openRegistrationDescription")}
              checked={settings.registrationOpen}
              onCheckedChange={(v) => handleSettingToggle({ registrationOpen: v })}
            />
            <ToggleRow
              label={t("oauthRegistration")}
              desc={t("oauthRegistrationDescription")}
              checked={settings.oauthRegistrationOpen}
              onCheckedChange={(v) => handleSettingToggle({ oauthRegistrationOpen: v })}
              last
            />
          </section>

          {/* OAuth Provider */}
          <section className="rounded-xl border border-border bg-card">
            <div className="px-6 py-4">
              <h2 className="text-sm font-semibold">{t("oauthProvider")}</h2>
            </div>
            <Separator />
            <ToggleRow
              label={t("enableOauth")}
              desc={t("enableOauthDescription")}
              checked={settings.oauth?.enabled ?? false}
              onCheckedChange={handleOAuthToggle}
            />

            {settings.oauth?.enabled && (
              <>
                <div className="border-t border-border px-6 py-5">
                  <label className="mb-2 block text-sm text-muted-foreground">{t("providerLabel")}</label>
                  <Input
                    value={settings.oauth.label}
                    readOnly
                    className="bg-muted/20"
                  />
                </div>
                <div className="border-t border-border px-6 pb-5">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="mb-2 block text-sm text-muted-foreground">{t("authorizeUrl")}</label>
                      <Input
                        value={settings.oauth.authorizeUrl}
                        readOnly
                        className="bg-muted/20 font-mono text-xs"
                      />
                    </div>
                    <div>
                      <label className="mb-2 block text-sm text-muted-foreground">{t("clientId")}</label>
                      <Input
                        value={settings.oauth.clientId}
                        readOnly
                        className="bg-muted/20 font-mono text-xs"
                      />
                    </div>
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </ScrollArea>
  )
}
