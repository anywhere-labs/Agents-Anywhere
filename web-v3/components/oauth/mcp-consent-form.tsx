"use client"

import { useState } from "react"
import { CheckCircle2Icon, LaptopIcon, MonitorIcon, ServerIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import { ResultCard, StepHeading } from "@/components/sign-in/sign-in-shell"
import { Spinner } from "@/components/spinner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { approveMcpAuthorization } from "@/lib/api/control-http"
import type { MessageKey } from "@/lib/i18n"
import {
  buildDenyRedirect,
  canApprove,
  defaultSelectedScopes,
  redirectHostLabel,
  visibleScopes,
  type AuthorizeRequest,
} from "@/lib/oauth/consent"
import type { DevicePlatform, McpConsentPreview, McpScope } from "@/lib/types/v3"
import { cn } from "@/lib/utils"

const SCOPE_COPY: Record<McpScope, { title: MessageKey; description: MessageKey }> = {
  "devices:read": { title: "oauth.scope.devicesRead", description: "oauth.scope.devicesReadDesc" },
  "sessions:read": { title: "oauth.scope.sessionsRead", description: "oauth.scope.sessionsReadDesc" },
  "sessions:write": { title: "oauth.scope.sessionsWrite", description: "oauth.scope.sessionsWriteDesc" },
  "approvals:answer": {
    title: "oauth.scope.approvalsAnswer",
    description: "oauth.scope.approvalsAnswerDesc",
  },
}

const PLATFORM_ICON: Record<DevicePlatform, typeof LaptopIcon> = {
  macos: LaptopIcon,
  linux: ServerIcon,
  windows: MonitorIcon,
}

const PLATFORM_LABEL: Record<DevicePlatform, string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
}

export function McpConsentForm({
  request,
  preview,
  serverUrl,
  accountEmail,
  getToken,
  onUseAnotherAccount,
}: {
  request: AuthorizeRequest
  preview: McpConsentPreview
  serverUrl: string
  accountEmail: string
  getToken: () => Promise<string>
  onUseAnotherAccount: () => void
}) {
  const { t } = useI18n()
  const scopes = visibleScopes(preview.scopes, request.scopes)
  const [selectedScopes, setSelectedScopes] = useState<McpScope[]>(() =>
    defaultSelectedScopes(scopes)
  )
  const [selectedDevices, setSelectedDevices] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [leaving, setLeaving] = useState(false)

  const client = preview.client_name
  const approvable = canApprove({ scopes: selectedScopes, deviceIds: selectedDevices })

  const toggleScope = (scope: McpScope, on: boolean) =>
    setSelectedScopes((prev) => (on ? [...new Set([...prev, scope])] : prev.filter((s) => s !== scope)))
  const toggleDevice = (id: string, on: boolean) =>
    setSelectedDevices((prev) => (on ? [...new Set([...prev, id])] : prev.filter((d) => d !== id)))

  const approve = async () => {
    if (!approvable) return
    setSubmitting(true)
    try {
      const token = await getToken()
      // Keep the server's scope order so the grant reads the same everywhere.
      const ordered = preview.scopes.map((s) => s.scope).filter((s) => selectedScopes.includes(s))
      const result = await approveMcpAuthorization(serverUrl, token, {
        clientId: preview.client_id,
        redirectUri: preview.redirect_uri,
        codeChallenge: request.codeChallenge,
        codeChallengeMethod: request.codeChallengeMethod,
        state: request.state,
        scopes: ordered,
        deviceIds: selectedDevices,
      })
      setLeaving(true)
      window.location.assign(result.redirect_url)
    } catch (err) {
      toast.error(t("oauth.approveFailed", { message: err instanceof Error ? err.message : String(err) }))
      setSubmitting(false)
    }
  }

  const deny = () => {
    setLeaving(true)
    // preview.redirect_uri has been checked against the client's registered URIs by the server.
    window.location.assign(buildDenyRedirect(preview.redirect_uri, request.state))
  }

  if (leaving) {
    return (
      <ResultCard
        icon={CheckCircle2Icon}
        title={t("oauth.redirecting", { client })}
        description={redirectHostLabel(preview.redirect_uri)}
      />
    )
  }

  return (
    <div className="w-full max-w-md space-y-6">
      <StepHeading
        title={t("oauth.title", { client })}
        description={t("oauth.description", { client })}
      />

      <dl className="divide-y divide-border rounded-card bg-card px-5 text-sm">
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-muted-foreground">{t("oauth.signedInAs")}</dt>
          <dd className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{accountEmail}</span>
            <Button variant="ghost" size="xs" onClick={onUseAnotherAccount}>
              {t("oauth.useAnotherAccount")}
            </Button>
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-muted-foreground">{t("oauth.redirectTo")}</dt>
          <dd className="min-w-0 truncate font-mono text-xs">{redirectHostLabel(preview.redirect_uri)}</dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-muted-foreground">{t("oauth.server")}</dt>
          <dd className="min-w-0 truncate font-mono text-xs">{serverUrl}</dd>
        </div>
      </dl>

      <section className="space-y-3">
        <h2 className="px-1 text-sm font-semibold">{t("oauth.permissionsTitle")}</h2>
        <div className="divide-y divide-border rounded-card bg-card px-5">
          {scopes.map((scope) => {
            const copy = SCOPE_COPY[scope.scope]
            if (!copy) return null
            const checked = selectedScopes.includes(scope.scope)
            return (
              <label
                key={scope.scope}
                className="flex cursor-pointer items-start justify-between gap-4 py-4"
              >
                <span className="min-w-0 space-y-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {t(copy.title)}
                    {scope.high_risk && (
                      <Badge variant="destructive" className="gap-1">
                        <TriangleAlertIcon className="size-3" />
                        {t("oauth.highRisk")}
                      </Badge>
                    )}
                  </span>
                  <span
                    className={cn(
                      "block text-xs leading-relaxed",
                      scope.high_risk ? "text-destructive" : "text-muted-foreground"
                    )}
                  >
                    {t(copy.description)}
                  </span>
                </span>
                <Switch
                  className="mt-0.5"
                  checked={checked}
                  onCheckedChange={(on) => toggleScope(scope.scope, on)}
                />
              </label>
            )
          })}
        </div>
      </section>

      <section className="space-y-3">
        <div className="space-y-1 px-1">
          <h2 className="text-sm font-semibold">{t("oauth.devicesTitle")}</h2>
          <p className="text-xs text-muted-foreground">{t("oauth.devicesDesc", { client })}</p>
        </div>
        {preview.eligible_devices.length === 0 ? (
          <p className="rounded-card bg-card p-5 text-sm text-muted-foreground">
            {t("oauth.devicesEmpty", { client })}
          </p>
        ) : (
          <div className="divide-y divide-border rounded-card bg-card px-5">
            {preview.eligible_devices.map((device) => {
              const Icon = PLATFORM_ICON[device.platform] ?? LaptopIcon
              return (
                <label key={device.id} className="flex cursor-pointer items-center gap-3 py-3">
                  <Checkbox
                    checked={selectedDevices.includes(device.id)}
                    onCheckedChange={(on) => toggleDevice(device.id, on)}
                  />
                  <Icon className="size-4 shrink-0 stroke-[1.5] text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{device.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {PLATFORM_LABEL[device.platform] ?? device.platform}
                  </span>
                </label>
              )
            })}
          </div>
        )}
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          {t("oauth.devicesNote", { setting: t("devices.allowMcp") })}
        </p>
      </section>

      <div className="space-y-3">
        <div className="flex flex-col-reverse gap-3 sm:flex-row">
          <Button variant="outline" size="lg" className="flex-1" disabled={submitting} onClick={deny}>
            {t("oauth.deny")}
          </Button>
          <Button
            size="lg"
            className="flex-1"
            disabled={!approvable || submitting}
            onClick={() => void approve()}
          >
            {submitting ? (
              <>
                <Spinner className="size-4 text-primary-foreground" />
                {t("oauth.approving")}
              </>
            ) : (
              t("oauth.approve")
            )}
          </Button>
        </div>
        <p className="text-center text-xs text-muted-foreground">
          {approvable ? t("oauth.revokeHint") : t("oauth.selectAtLeastOne")}
        </p>
      </div>
    </div>
  )
}
