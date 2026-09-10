"use client"

import { useState, useEffect } from "react"
import { ChevronLeft, Copy, Check } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/components/workspace-context"
import { getServiceInfo, getSettings, updateSettings, type ServiceInfo, type InstanceSettings } from "@/lib/api"

const MOCK_TOKEN = "mock-token"

function formatUptime(seconds: number) {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function CopyButton({ text }: { text: string }) {
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
      aria-label="复制"
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
  const [serviceInfo, setServiceInfo] = useState<ServiceInfo | null>(null)
  const [settings, setSettings] = useState<InstanceSettings | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([getServiceInfo(MOCK_TOKEN), getSettings(MOCK_TOKEN)]).then(
      ([info, s]) => {
        setServiceInfo(info)
        setSettings(s)
        setLoading(false)
      },
    )
  }, [])

  const handleSettingToggle = async (patch: Partial<InstanceSettings>) => {
    if (!settings) return
    const optimistic = { ...settings, ...patch }
    setSettings(optimistic)
    const updated = await updateSettings(MOCK_TOKEN, patch)
    setSettings(updated)
  }

  const handleOAuthToggle = async (enabled: boolean) => {
    if (!settings) return
    const patch: Partial<InstanceSettings> = {
      oauth: settings.oauth ? { ...settings.oauth, enabled } : null,
    }
    const optimistic = { ...settings, ...patch }
    setSettings(optimistic)
    const updated = await updateSettings(MOCK_TOKEN, patch)
    setSettings(updated)
  }

  if (loading || !serviceInfo || !settings) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading...
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-3xl px-8 pt-8 pb-16">
        <button
          type="button"
          onClick={() => navigate("home")}
          className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          Back
        </button>

        <h1 className="text-2xl font-semibold">Service</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configuration and runtime info for this instance.
        </p>

        <div className="mt-6 space-y-4">
          {/* Server info */}
          <section className="rounded-xl border border-border bg-card">
            <div className="px-6 py-4">
              <h2 className="text-sm font-semibold">Server</h2>
            </div>
            <Separator />
            <InfoRow label="Endpoint" copyText={serviceInfo.endpoint}>
              <span className="font-mono text-sm">{serviceInfo.endpoint}</span>
            </InfoRow>
            <InfoRow label="Version">
              <span className="font-mono text-sm">{serviceInfo.version}</span>
            </InfoRow>
            <InfoRow
              label="Database"
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
            <InfoRow label="Uptime" last>
              <span className="font-mono text-sm">{formatUptime(serviceInfo.uptimeSeconds)}</span>
            </InfoRow>
          </section>

          {/* Access */}
          <section className="rounded-xl border border-border bg-card">
            <div className="px-6 py-4">
              <h2 className="text-sm font-semibold">Access</h2>
            </div>
            <Separator />
            <ToggleRow
              label="Open registration"
              desc="When enabled, anyone reaching the sign-in page can create their own account. When disabled, only admins can add users from the Team page."
              checked={settings.registrationOpen}
              onCheckedChange={(v) => handleSettingToggle({ registrationOpen: v })}
            />
            <ToggleRow
              label="OAuth registration"
              desc="When enabled, a new OAuth identity can create a local account. Existing linked OAuth accounts can still sign in when disabled."
              checked={settings.oauthRegistrationOpen}
              onCheckedChange={(v) => handleSettingToggle({ oauthRegistrationOpen: v })}
              last
            />
          </section>

          {/* OAuth Provider */}
          <section className="rounded-xl border border-border bg-card">
            <div className="px-6 py-4">
              <h2 className="text-sm font-semibold">OAuth Sign-in Provider</h2>
            </div>
            <Separator />
            <ToggleRow
              label="Enable OAuth sign-in"
              desc="Configure the upstream OAuth/OIDC provider used on the web sign-in page."
              checked={settings.oauth?.enabled ?? false}
              onCheckedChange={handleOAuthToggle}
            />

            {settings.oauth?.enabled && (
              <>
                <div className="border-t border-border px-6 py-5">
                  <label className="mb-2 block text-sm text-muted-foreground">Provider label</label>
                  <Input
                    value={settings.oauth.label}
                    readOnly
                    className="bg-muted/20"
                  />
                </div>
                <div className="border-t border-border px-6 pb-5">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="mb-2 block text-sm text-muted-foreground">Authorize URL</label>
                      <Input
                        value={settings.oauth.authorizeUrl}
                        readOnly
                        className="bg-muted/20 font-mono text-xs"
                      />
                    </div>
                    <div>
                      <label className="mb-2 block text-sm text-muted-foreground">Client ID</label>
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
    </div>
  )
}
