"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  CloudIcon,
  ExternalLinkIcon,
  FlaskConicalIcon,
  KeyRoundIcon,
  LockIcon,
  MonitorIcon,
  MoonIcon,
  RefreshCwIcon,
  ShieldIcon,
  SunIcon,
  Trash2Icon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { toast } from "sonner"

import { ConfirmDialog } from "@/components/console/confirm-dialog"
import { CopyableValue } from "@/components/console/copyable-value"
import { DetailCard, type DetailItem } from "@/components/console/detail-list"
import { PageContainer, PageHeader } from "@/components/console/page-header"
import { formatBytes } from "@/components/conversation/text"
import { DropdownSelect } from "@/components/dropdown-select"
import { Field } from "@/components/field"
import { useI18n } from "@/components/i18n-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { E2eeLockBadge } from "@/components/workbench/e2ee-lock-badge"
import { WorkbenchShell } from "@/components/workbench/workbench-shell"
import {
  deleteAdminDrivePolicy,
  deleteDriveFile,
  fetchAdminDrivePolicy,
  fetchAuthConfig,
  listDriveFiles,
  listMcpGrants,
  revokeMcpGrant,
  updateAdminDrivePolicy,
} from "@/lib/api/control-http"
import type { Locale } from "@/lib/i18n"
import { getControlledModeSupport } from "@/lib/assistant/controlled-mode"
import { formatKeyFingerprint } from "@/lib/mesh/pairing"
import { useWorkbench } from "@/lib/state/workbench-context"
import type {
  AdminDrivePolicyResponse,
  DriveFileView,
  DriveQuotaView,
  McpGrantView,
} from "@/lib/types/v3"
import { cn } from "@/lib/utils"

const LOCALE_OPTIONS: readonly { value: Locale; label: string }[] = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" },
]

export default function SettingsPage() {
  const { t, locale, setLocale } = useI18n()
  const { theme, setTheme } = useTheme()
  const {
    activeAccount,
    clientIdentity,
    preferences,
    deviceTrusts,
    getFreshAccessToken,
    setAssistantPrimary,
    updatePreferences,
    removeLocalDeviceTrust,
    resetBrowserVault,
  } = useWorkbench()
  const controlledModeSupport = getControlledModeSupport()

  const [oidcIssuer, setOidcIssuer] = useState<string | null>(null)
  const [driveFiles, setDriveFiles] = useState<DriveFileView[]>([])
  const [driveQuota, setDriveQuota] = useState<DriveQuotaView | null>(null)
  const [mcpGrants, setMcpGrants] = useState<McpGrantView[]>([])
  const [loadingRemote, setLoadingRemote] = useState(false)
  const [revokeGrantTarget, setRevokeGrantTarget] = useState<McpGrantView | null>(null)
  const [resetVaultOpen, setResetVaultOpen] = useState(false)
  const [browserFp, setBrowserFp] = useState<string | null>(null)

  // Admin per-account Drive policy state (rendered ONLY when activeAccount.user.role === "admin")
  const [adminUserId, setAdminUserId] = useState("")
  const [adminPolicy, setAdminPolicy] = useState<AdminDrivePolicyResponse | null>(null)
  const [adminQuotaMb, setAdminQuotaMb] = useState("")
  const [adminMaxFileMb, setAdminMaxFileMb] = useState("")
  const [adminTtlDays, setAdminTtlDays] = useState("")

  useEffect(() => {
    if (!clientIdentity?.publicKey) return
    let alive = true
    void formatKeyFingerprint(clientIdentity.publicKey).then((fp) => {
      if (alive) setBrowserFp(fp)
    })
    return () => {
      alive = false
    }
  }, [clientIdentity?.publicKey])

  const loadRemoteSettings = useCallback(async () => {
    if (!activeAccount) return
    setLoadingRemote(true)
    try {
      const tok = await getFreshAccessToken()
      const [cfg, drive, grants] = await Promise.all([
        fetchAuthConfig(activeAccount.serverUrl).catch(() => null),
        listDriveFiles(activeAccount.serverUrl, tok).catch(() => null),
        listMcpGrants(activeAccount.serverUrl, tok).catch(() => []),
      ])
      setOidcIssuer(cfg?.oidc?.issuer ?? null)
      setDriveFiles(drive?.files ?? [])
      setDriveQuota(drive?.quota ?? null)
      setMcpGrants(grants)
    } finally {
      setLoadingRemote(false)
    }
  }, [activeAccount, getFreshAccessToken])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void loadRemoteSettings()
    })
    return () => {
      active = false
    }
  }, [loadRemoteSettings])

  // Friendly, human-readable allowance descriptions (never exposing raw technical claim keys!)
  const accountAllowances = useMemo<DetailItem[]>(() => {
    if (!activeAccount) return []
    const ent = activeAccount.user.entitlements ?? {}
    const items: DetailItem[] = [
      {
        key: "role",
        label: t("settings.role"),
        value:
          activeAccount.user.role === "admin" ? t("shell.adminLabel") : t("shell.memberLabel"),
      },
      {
        key: "authMode",
        label: t("settings.authMode"),
        value:
          activeAccount.authMode === "oidc"
            ? t("settings.authModeOidc")
            : t("settings.authModeLocal"),
      },
    ]

    if (ent["aa.max_devices"] !== undefined) {
      const val = Number(ent["aa.max_devices"])
      items.push({
        key: "maxDevices",
        label: t("settings.allowanceMaxDevices"),
        description: t("settings.allowanceMaxDevicesDesc"),
        value: val <= 0 ? t("common.unlimited") : `${val}`,
      })
    }
    if (ent["aa.drive_quota_mb"] !== undefined || driveQuota?.enabled) {
      const bytes = driveQuota?.enabled
        ? driveQuota.quota_bytes
        : Number(ent["aa.drive_quota_mb"] ?? 0) * 1024 * 1024
      items.push({
        key: "driveQuota",
        label: t("settings.allowanceDriveQuota"),
        description: t("settings.allowanceDriveQuotaDesc"),
        value: bytes != null && bytes > 0 ? formatBytes(bytes) : t("common.unlimited"),
      })
    }
    if (ent["aa.drive_ttl_days"] !== undefined || driveQuota?.enabled) {
      const days = driveQuota?.enabled
        ? Math.round(driveQuota.default_ttl_seconds / 86400)
        : Number(ent["aa.drive_ttl_days"] ?? 7)
      items.push({
        key: "driveTtl",
        label: t("settings.allowanceDriveTtl"),
        description: t("settings.allowanceDriveTtlDesc"),
        value: locale === "zh-CN" ? `${days} 天` : `${days} days`,
      })
    }
    if (ent["aa.drive_max_file_mb"] !== undefined || driveQuota?.enabled) {
      const bytes = driveQuota?.enabled
        ? driveQuota.max_file_bytes
        : Number(ent["aa.drive_max_file_mb"] ?? 0) * 1024 * 1024
      items.push({
        key: "maxFile",
        label: t("settings.allowanceMaxFile"),
        description: t("settings.allowanceMaxFileDesc"),
        value: bytes != null && bytes > 0 ? formatBytes(bytes) : t("common.unlimited"),
      })
    }
    return items
  }, [activeAccount, driveQuota, locale, t])

  const handleLookupAdminPolicy = async () => {
    if (!activeAccount || !adminUserId.trim()) return
    try {
      const tok = await getFreshAccessToken()
      const res = await fetchAdminDrivePolicy(activeAccount.serverUrl, tok, adminUserId.trim())
      setAdminPolicy(res)
      setAdminQuotaMb(
        res.override?.quota_bytes ? String(Math.round(res.override.quota_bytes / (1024 * 1024))) : ""
      )
      setAdminMaxFileMb(
        res.override?.max_file_bytes
          ? String(Math.round(res.override.max_file_bytes / (1024 * 1024)))
          : ""
      )
      setAdminTtlDays(
        res.override?.default_ttl_seconds
          ? String(Math.round(res.override.default_ttl_seconds / 86400))
          : ""
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSaveAdminPolicy = async () => {
    if (!activeAccount || !adminUserId.trim()) return
    try {
      const tok = await getFreshAccessToken()
      const res = await updateAdminDrivePolicy(activeAccount.serverUrl, tok, adminUserId.trim(), {
        quota_bytes: adminQuotaMb ? Number(adminQuotaMb) * 1024 * 1024 : null,
        max_file_bytes: adminMaxFileMb ? Number(adminMaxFileMb) * 1024 * 1024 : null,
        default_ttl_seconds: adminTtlDays ? Number(adminTtlDays) * 86400 : null,
      })
      setAdminPolicy(res)
      toast.success(t("common.saved"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleResetAdminPolicy = async () => {
    if (!activeAccount || !adminUserId.trim()) return
    try {
      const tok = await getFreshAccessToken()
      const res = await deleteAdminDrivePolicy(activeAccount.serverUrl, tok, adminUserId.trim())
      setAdminPolicy(res)
      setAdminQuotaMb("")
      setAdminMaxFileMb("")
      setAdminTtlDays("")
      toast.success(t("common.saved"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const pinnedTrusts = useMemo(() => Object.values(deviceTrusts), [deviceTrusts])

  return (
    <WorkbenchShell>
      <div className="flex-1 overflow-y-auto">
        <PageContainer>
          <PageHeader
            title={t("settings.title")}
            description={t("settings.description")}
            actions={
              <Button
                variant="outline"
                size="sm"
                disabled={loadingRemote}
                onClick={() => void loadRemoteSettings()}
              >
                <RefreshCwIcon
                  className={loadingRemote ? "size-3.5 animate-spin" : "size-3.5"}
                />
                {t("common.refresh")}
              </Button>
            }
          />

          {/* 1. Appearance & Sidebar Mode */}
          <section className="space-y-6 rounded-card bg-card p-6">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold tracking-tight">
                {t("settings.appearanceTitle")}
              </h2>
              <p className="text-sm text-muted-foreground">{t("settings.appearanceDesc")}</p>
            </div>

            <div className="space-y-5 border-t border-border pt-5">
              {/* Theme tiles */}
              <div className="space-y-2.5">
                <p className="text-sm font-medium text-foreground">{t("settings.theme")}</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    { id: "light", label: t("common.themeLight"), Icon: SunIcon },
                    { id: "dark", label: t("common.themeDark"), Icon: MoonIcon },
                    { id: "system", label: t("common.themeSystem"), Icon: MonitorIcon },
                  ].map(({ id, label, Icon }) => {
                    const active = theme === id
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setTheme(id)}
                        className={cn(
                          "flex items-center gap-3 rounded-xl px-4 py-3 text-left text-sm transition-colors",
                          active
                            ? "bg-surface-raised font-medium text-foreground ring-1 ring-foreground/20"
                            : "bg-background text-muted-foreground hover:text-foreground"
                        )}
                      >
                        <Icon className="size-4 shrink-0" />
                        <span>{label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Language selector (lives exclusively here — never duplicated in sidebar) */}
              <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-5">
                <p className="text-sm font-medium text-foreground">{t("common.language")}</p>
                <DropdownSelect
                  value={locale}
                  options={LOCALE_OPTIONS}
                  onChange={setLocale}
                  label={t("common.language")}
                  align="end"
                />
              </div>

              {/* Assistant-first ("助手为主角") Sidebar Toggle */}
              <div className="flex items-start justify-between gap-6 border-t border-border pt-5">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">
                    {t("settings.assistantPrimary")}
                  </p>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {t("settings.assistantPrimaryDesc")}
                  </p>
                </div>
                <Switch
                  checked={preferences.assistantPrimary}
                  onCheckedChange={(checked) => void setAssistantPrimary(Boolean(checked))}
                />
              </div>
            </div>
          </section>

          {/* 2. Workspace Account, Role & Friendly Allowances (no IdP / OAuth server UI in AA!) */}
          {activeAccount && (
            <DetailCard
              title={t("settings.accountTitle")}
              description={`${activeAccount.user.display_name} · ${activeAccount.user.email}`}
              items={accountAllowances}
              headerAction={
                activeAccount.authMode === "oidc" && oidcIssuer ? (
                  <Button
                    variant="outline"
                    size="sm"
                    render={
                      <a href={oidcIssuer} target="_blank" rel="noopener noreferrer" />
                    }
                  >
                    <ExternalLinkIcon className="size-3.5" />
                    {t("settings.manageAtIdp")}
                  </Button>
                ) : undefined
              }
            />
          )}

          {/* 3. Cloud Drive */}
          <section className="space-y-4 rounded-card bg-card p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1">
                <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                  <CloudIcon className="size-4" />
                  {t("settings.driveTitle")}
                </h2>
                <p className="text-sm text-muted-foreground">{t("settings.driveDesc")}</p>
              </div>
              {driveQuota?.enabled && (
                <Badge variant="secondary">
                  {t("settings.driveUsed", {
                    used: formatBytes(driveQuota.used_bytes),
                    count: driveQuota.file_count,
                  })}
                </Badge>
              )}
            </div>

            {!driveQuota?.enabled ? (
              <p className="border-t border-border pt-4 text-sm text-muted-foreground">
                {t("settings.driveDisabled")}
              </p>
            ) : driveFiles.length === 0 ? (
              <p className="border-t border-border pt-4 text-sm text-muted-foreground">—</p>
            ) : (
              <div className="divide-y divide-border border-t border-border pt-2">
                {driveFiles.map((file) => (
                  <div
                    key={file.id}
                    className="flex items-center justify-between gap-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs font-medium text-foreground">
                        {file.vfs_path || file.filename || file.id}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatBytes(file.size_bytes)} · {file.purpose}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={async () => {
                        if (!activeAccount) return
                        const tok = await getFreshAccessToken()
                        await deleteDriveFile(activeAccount.serverUrl, tok, file.id)
                        await loadRemoteSettings()
                        toast.success(t("common.saved"))
                      }}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 4. Admin-only Per-Account Cloud Drive Policy Override */}
          {activeAccount?.user.role === "admin" && (
            <section className="space-y-4 rounded-card bg-card p-6">
              <div className="space-y-1">
                <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                  <ShieldIcon className="size-4" />
                  {t("settings.adminDriveTitle")}
                </h2>
                <p className="text-sm text-muted-foreground">{t("settings.adminDriveDesc")}</p>
              </div>
              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                <Input
                  value={adminUserId}
                  onChange={(e) => setAdminUserId(e.target.value)}
                  className="max-w-sm font-mono text-xs"
                  placeholder="Target user ID"
                />
                <Button variant="outline" size="sm" onClick={() => void handleLookupAdminPolicy()}>
                  Lookup
                </Button>
              </div>
              {adminPolicy && (
                <div className="space-y-4 pt-2">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Quota override (MB)">
                      <Input
                        type="number"
                        value={adminQuotaMb}
                        onChange={(e) => setAdminQuotaMb(e.target.value)}
                      />
                    </Field>
                    <Field label="Max file override (MB)">
                      <Input
                        type="number"
                        value={adminMaxFileMb}
                        onChange={(e) => setAdminMaxFileMb(e.target.value)}
                      />
                    </Field>
                    <Field label="Retention override (days)">
                      <Input
                        type="number"
                        value={adminTtlDays}
                        onChange={(e) => setAdminTtlDays(e.target.value)}
                      />
                    </Field>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => void handleSaveAdminPolicy()}>
                      {t("common.save")}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void handleResetAdminPolicy()}>
                      Reset override
                    </Button>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* 5. Authorized MCP Connections (/mcp/grants) */}
          <section className="space-y-4 rounded-card bg-card p-6">
            <div className="space-y-1">
              <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                <KeyRoundIcon className="size-4" />
                {t("settings.mcpGrantsTitle")}
              </h2>
              <p className="text-sm text-muted-foreground">{t("settings.mcpGrantsDesc")}</p>
            </div>
            {mcpGrants.length === 0 ? (
              <p className="border-t border-border pt-4 text-sm text-muted-foreground">
                {t("settings.mcpGrantsEmpty")}
              </p>
            ) : (
              <div className="divide-y divide-border border-t border-border pt-2">
                {mcpGrants.map((grant) => (
                  <div
                    key={grant.id}
                    className="flex flex-wrap items-center justify-between gap-4 py-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-medium text-foreground">{grant.client_name}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {grant.scopes.map((s) => (
                          <Badge key={s} variant="secondary" className="font-mono text-[11px]">
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setRevokeGrantTarget(grant)}
                    >
                      {t("common.delete")}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 6. Experimental assistant features (docs/v3/assistant-and-files-proposal.md §7) — all off by default */}
          <section className="space-y-4 rounded-card bg-card p-6">
            <div className="space-y-1">
              <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                <FlaskConicalIcon className="size-4" />
                {t("settings.experimentalTitle")}
              </h2>
              <p className="text-sm text-muted-foreground">{t("settings.experimentalDesc")}</p>
            </div>

            <div className="flex items-start justify-between gap-6 border-t border-border pt-4">
              <div className="space-y-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                  {t("settings.jsExecution")}
                  <Badge variant="outline">{t("settings.experimentalBadge")}</Badge>
                </p>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {t("settings.jsExecutionDesc")}
                </p>
              </div>
              <Switch
                checked={preferences.assistantExperimental.jsExecution}
                onCheckedChange={(checked) =>
                  void updatePreferences({
                    assistantExperimental: {
                      ...preferences.assistantExperimental,
                      jsExecution: Boolean(checked),
                    },
                  })
                }
              />
            </div>

            <div className="flex items-start justify-between gap-6 border-t border-border pt-4">
              <div className="space-y-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                  {t("settings.controlledMode")}
                  <Badge variant="outline">{t("settings.experimentalBadge")}</Badge>
                </p>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {t("settings.controlledModeDesc")}
                </p>
                {!controlledModeSupport.available && (
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {t("settings.controlledModeUnavailable")}
                  </p>
                )}
              </div>
              <Switch
                checked={controlledModeSupport.available && preferences.assistantExperimental.controlledMode}
                disabled={!controlledModeSupport.available}
                onCheckedChange={(checked) =>
                  void updatePreferences({
                    assistantExperimental: {
                      ...preferences.assistantExperimental,
                      controlledMode: Boolean(checked),
                    },
                  })
                }
              />
            </div>
          </section>

          {/* 7. Local Browser E2EE Vault */}
          <section className="space-y-5 rounded-card bg-card p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1">
                <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                  <LockIcon className="size-4 text-muted-foreground" />
                  {t("settings.vaultTitle")}
                </h2>
                <p className="text-sm text-muted-foreground">{t("settings.vaultDesc")}</p>
              </div>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setResetVaultOpen(true)}
              >
                {t("settings.resetVault")}
              </Button>
            </div>

            {clientIdentity && (
              <div className="space-y-3 border-t border-border pt-4">
                <CopyableValue
                  label={t("settings.browserKey")}
                  value={clientIdentity.publicKey}
                  copyLabel={t("common.copy")}
                  copyFailedLabel={t("common.copyFailed")}
                />
                {browserFp && (
                  <p className="font-mono text-xs text-muted-foreground">SHA-256: {browserFp}</p>
                )}
              </div>
            )}

            <div className="space-y-3 border-t border-border pt-4">
              <p className="text-sm font-medium text-foreground">{t("settings.pinnedDevices")}</p>
              {pinnedTrusts.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("settings.noPinnedDevices")}</p>
              ) : (
                <div className="divide-y divide-border">
                  {pinnedTrusts.map((trust) => (
                    <div
                      key={trust.device_id}
                      className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">
                            {trust.device_name_hint || trust.device_id}
                          </span>
                          <E2eeLockBadge paired compact />
                        </div>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {trust.device_pub}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => void removeLocalDeviceTrust(trust.device_id)}
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </PageContainer>
      </div>

      <ConfirmDialog
        open={Boolean(revokeGrantTarget)}
        onOpenChange={(open) => {
          if (!open) setRevokeGrantTarget(null)
        }}
        title={revokeGrantTarget?.client_name ?? ""}
        description={t("settings.mcpGrantsDesc")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={async () => {
          if (!activeAccount || !revokeGrantTarget) return
          const tok = await getFreshAccessToken()
          await revokeMcpGrant(activeAccount.serverUrl, tok, revokeGrantTarget.id)
          setRevokeGrantTarget(null)
          await loadRemoteSettings()
          toast.success(t("common.saved"))
        }}
      />

      <ConfirmDialog
        open={resetVaultOpen}
        onOpenChange={setResetVaultOpen}
        title={t("settings.resetVault")}
        description={t("settings.resetVaultConfirm")}
        confirmLabel={t("common.confirm")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={async () => {
          await resetBrowserVault()
          setResetVaultOpen(false)
          toast.success(t("common.saved"))
        }}
      />
    </WorkbenchShell>
  )
}
