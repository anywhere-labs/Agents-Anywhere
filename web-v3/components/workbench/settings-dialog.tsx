"use client"

// 设置, from the account menu at the bottom left (or ⌘,): a large dialog with its own section list, like Effi's and
// Claude's settings (`split-dialog.tsx`). Administration is not here: it has its own console at /admin (anywhere-ui console template).
import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  CloudIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LockIcon,
  MonitorIcon,
  MoonIcon,
  SlidersHorizontalIcon,
  SunIcon,
  UserIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { toast } from "sonner"

import { ConfirmDialog } from "@/components/console/confirm-dialog"
import { DetailList, type DetailItem } from "@/components/console/detail-list"
import { formatBytes } from "@/components/conversation/text"
import { DriveUsage } from "@/components/drive/drive-usage"
import { DropdownSelect } from "@/components/dropdown-select"
import { useI18n } from "@/components/i18n-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { fetchAuthConfig, listDriveFiles, listMcpGrants, revokeMcpGrant } from "@/lib/api/control-http"
import { getControlledModeSupport } from "@/lib/assistant/controlled-mode"
import type { Locale, MessageKey } from "@/lib/i18n"
import { formatKeyFingerprint } from "@/lib/mesh/pairing"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { DriveQuotaView, McpGrantView } from "@/lib/types/v3"
import { cn } from "@/lib/utils"
import { Card, Group, Note, Row } from "@/components/workbench/settings-parts"
import { SplitDialog } from "@/components/workbench/split-dialog"

export type SettingsSection = "general" | "account" | "drive" | "apps" | "encryption"

const SECTIONS: { id: SettingsSection; label: MessageKey; Icon: typeof UserIcon }[] = [
  { id: "general", label: "settings.nav.general", Icon: SlidersHorizontalIcon },
  { id: "account", label: "settings.nav.account", Icon: UserIcon },
  { id: "drive", label: "settings.nav.drive", Icon: CloudIcon },
  { id: "apps", label: "settings.nav.apps", Icon: KeyRoundIcon },
  { id: "encryption", label: "settings.nav.encryption", Icon: LockIcon },
]

/** Earlier anchors (`/settings#vault` …), still in old links. */
const LEGACY_SECTIONS: Record<string, SettingsSection> = { appearance: "general", mcp: "apps", vault: "encryption" }

export function settingsSectionFrom(raw: string | null | undefined): SettingsSection | null {
  if (!raw) return null
  const id = decodeURIComponent(raw.replace(/^#/, ""))
  const mapped = LEGACY_SECTIONS[id] ?? id
  return SECTIONS.some((s) => s.id === mapped) ? (mapped as SettingsSection) : null
}

const LOCALE_OPTIONS: readonly { value: Locale; label: string }[] = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" },
]

/** A size limit, or "unlimited" when there is none. */
function sizeOrUnlimited(bytes: number | null | undefined, unlimited: string): string {
  return bytes && bytes > 0 ? formatBytes(bytes) : unlimited
}

const SCOPE_LABELS: Partial<Record<string, MessageKey>> = {
  "devices:read": "settings.scope.devicesRead",
  "sessions:read": "settings.scope.sessionsRead",
  "sessions:write": "settings.scope.sessionsWrite",
}

export function SettingsDialog({
  open,
  onOpenChange,
  section,
  onSection,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null: phones show the section list (wider screens the first section). */
  section: SettingsSection | null
  onSection: (section: SettingsSection | null) => void
}) {
  const { t } = useI18n()
  const sections = useMemo(() => SECTIONS.map(({ id, label, Icon }) => ({ id, label: t(label), Icon })), [t])
  return (
    <SplitDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("settings.title")}
      description={t("settings.dialogDesc")}
      sections={sections}
      section={section}
      onSection={onSection}
    >
      <SettingsBody section={section ?? "general"} active={open} onClose={() => onOpenChange(false)} />
    </SplitDialog>
  )
}

// ── Pieces every section uses ─────────────────────────────────────────────────────────────────────────────────────

/** One setting: what it is (and a line on what it does) on the left, its control or value on the right. */

// ── Sections ─────────────────────────────────────────────────────────────────────────────────────────────────────

function SettingsBody({ section, active, onClose }: { section: SettingsSection; active: boolean; onClose: () => void }) {
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
  const experimental = preferences.assistantExperimental
  const setExperimental = (patch: Partial<typeof experimental>) =>
    void updatePreferences({ assistantExperimental: { ...experimental, ...patch } })
  const controlledMode = getControlledModeSupport()

  const [oidcIssuer, setOidcIssuer] = useState<string | null>(null)
  const [driveQuota, setDriveQuota] = useState<DriveQuotaView | null>(null)
  const [mcpGrants, setMcpGrants] = useState<McpGrantView[]>([])
  const [loading, setLoading] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<McpGrantView | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [fingerprints, setFingerprints] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    if (!activeAccount) return
    setLoading(true)
    try {
      const tok = await getFreshAccessToken()
      const [cfg, drive, grants] = await Promise.all([
        fetchAuthConfig(activeAccount.serverUrl).catch(() => null),
        listDriveFiles(activeAccount.serverUrl, tok).catch(() => null),
        listMcpGrants(activeAccount.serverUrl, tok).catch(() => []),
      ])
      setOidcIssuer(cfg?.oidc?.issuer ?? null)
      setDriveQuota(drive?.quota ?? null)
      setMcpGrants(grants)
    } finally {
      setLoading(false)
    }
  }, [activeAccount, getFreshAccessToken])

  useEffect(() => {
    if (!active) return
    let alive = true
    queueMicrotask(() => {
      if (alive) void load()
    })
    return () => {
      alive = false
    }
  }, [active, load])

  // Key fingerprints (this browser's and each paired device's), computed once per key.
  const trusts = useMemo(() => Object.values(deviceTrusts), [deviceTrusts])
  useEffect(() => {
    let alive = true
    const keys = [clientIdentity?.publicKey, ...trusts.map((x) => x.device_pub)].filter((k): k is string => Boolean(k))
    for (const key of keys) {
      if (fingerprints[key]) continue
      void formatKeyFingerprint(key).then((fp) => {
        if (alive) setFingerprints((prev) => ({ ...prev, [key]: fp }))
      })
    }
    return () => {
      alive = false
    }
  }, [clientIdentity?.publicKey, trusts, fingerprints])

  const limits = useMemo<DetailItem[]>(() => {
    if (!activeAccount) return []
    const ent = activeAccount.user.entitlements ?? {}
    const items: DetailItem[] = []
    if (ent["aa.max_devices"] !== undefined) {
      const val = Number(ent["aa.max_devices"])
      items.push({ key: "maxDevices", label: t("settings.allowanceMaxDevices"), value: val <= 0 ? t("common.unlimited") : `${val}` })
    }
    if (driveQuota?.enabled) {
      const days = Math.round(driveQuota.default_ttl_seconds / 86400)
      items.push(
        {
          key: "driveQuota",
          label: t("settings.allowanceDriveQuota"),
          value: sizeOrUnlimited(driveQuota.quota_bytes, t("common.unlimited")),
        },
        { key: "driveTtl", label: t("settings.allowanceDriveTtl"), value: locale === "zh-CN" ? `${days} 天` : `${days} days` },
        {
          key: "maxFile",
          label: t("settings.allowanceMaxFile"),
          value: sizeOrUnlimited(driveQuota.max_file_bytes, t("common.unlimited")),
        }
      )
    }
    return items
  }, [activeAccount, driveQuota, locale, t])

  const copy = (text: string) =>
    void navigator.clipboard
      ?.writeText(text)
      .then(() => toast.success(t("common.copied")))
      .catch(() => toast.error(t("common.copyFailed")))

  return (
    <div className="space-y-8 pt-1">
      {section === "general" && (
        <Group>
          <Card>
            <Row label={t("settings.theme")}>
              <div className="flex gap-1 rounded-full bg-background p-1">
                {[
                  { id: "light", label: t("common.themeLight"), Icon: SunIcon },
                  { id: "dark", label: t("common.themeDark"), Icon: MoonIcon },
                  { id: "system", label: t("common.themeSystem"), Icon: MonitorIcon },
                ].map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={theme === id}
                    onClick={() => setTheme(id)}
                    className={cn(
                      "flex h-7 items-center gap-1.5 rounded-full px-3 text-sm transition-colors",
                      theme === id ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Icon className="size-3.5" />
                    {label}
                  </button>
                ))}
              </div>
            </Row>
            <Row label={t("common.language")}>
              <DropdownSelect value={locale} options={LOCALE_OPTIONS} onChange={setLocale} label={t("common.language")} align="end" />
            </Row>
            <Row label={t("settings.assistantPrimary")} hint={t("settings.assistantPrimaryDesc")}>
              <Switch checked={preferences.assistantPrimary} onCheckedChange={(checked) => void setAssistantPrimary(Boolean(checked))} />
            </Row>
          </Card>
        </Group>
      )}

      {/* Orches' experimental features (docs/v3/assistant-and-files-proposal.md §7), all off by default. */}
      {section === "general" && (
        <Group title={t("settings.experimentalTitle")} description={t("settings.experimentalDesc")}>
          <Card>
            <Row label={t("settings.jsExecution")} hint={t("settings.jsExecutionDesc")}>
              <Switch checked={experimental.jsExecution} onCheckedChange={(checked) => setExperimental({ jsExecution: Boolean(checked) })} />
            </Row>
            <Row
              label={t("settings.controlledMode")}
              hint={
                controlledMode.available
                  ? t("settings.controlledModeDesc")
                  : `${t("settings.controlledModeDesc")} ${t("settings.controlledModeUnavailable")}`
              }
            >
              <Switch
                checked={controlledMode.available && experimental.controlledMode}
                disabled={!controlledMode.available}
                onCheckedChange={(checked) => setExperimental({ controlledMode: Boolean(checked) })}
              />
            </Row>
          </Card>
        </Group>
      )}

      {section === "account" && activeAccount && (
        <>
          <Group
            action={
              activeAccount.authMode === "oidc" && oidcIssuer ? (
                <Button variant="outline" size="sm" render={<a href={oidcIssuer} target="_blank" rel="noopener noreferrer" />}>
                  <ExternalLinkIcon className="size-3.5" />
                  {t("settings.manageAtIdp")}
                </Button>
              ) : undefined
            }
          >
            <Card>
              <Row label={t("settings.accountName")}>
                <span className="text-sm text-muted-foreground">{activeAccount.user.display_name || "—"}</span>
              </Row>
              <Row label={t("settings.accountEmail")}>
                <span className="text-sm text-muted-foreground">{activeAccount.user.email ?? "—"}</span>
              </Row>
              <Row label={t("settings.role")}>
                <span className="text-sm text-muted-foreground">
                  {activeAccount.user.role === "admin" ? t("shell.adminLabel") : t("shell.memberLabel")}
                </span>
              </Row>
              <Row label={t("settings.authMode")}>
                <span className="text-sm text-muted-foreground">
                  {activeAccount.authMode === "oidc" ? t("settings.authModeOidc") : t("settings.authModeLocal")}
                </span>
              </Row>
            </Card>
          </Group>
          {limits.length > 0 && (
            <Group title={t("settings.limitsTitle")}>
              <div className="rounded-2xl bg-card p-4">
                <DetailList items={limits} />
              </div>
            </Group>
          )}
        </>
      )}

      {section === "drive" && (
        <Group description={t("settings.driveDesc")}>
          <Card>
            {!driveQuota?.enabled ? (
              <Note>{loading ? t("common.loading") : t("settings.driveDisabled")}</Note>
            ) : (
              <div className="space-y-3 py-3.5">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm text-foreground">{t("settings.driveUsedLabel")}</p>
                  <Button variant="outline" size="sm" render={<Link href="/drive" onClick={onClose} />} nativeButton={false}>
                    {t("settings.openDrive")}
                  </Button>
                </div>
                <DriveUsage quota={driveQuota} />
              </div>
            )}
          </Card>
        </Group>
      )}

      {section === "apps" && (
        <Group description={t("settings.mcpGrantsDesc")}>
          <Card>
            {mcpGrants.length === 0 ? (
              <Note>{loading ? t("common.loading") : t("settings.mcpGrantsEmpty")}</Note>
            ) : (
              mcpGrants.map((grant) => (
                <div key={grant.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 space-y-1.5">
                    <p className="text-sm text-foreground">{grant.client_name}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {grant.scopes.map((scope) => {
                        const label = SCOPE_LABELS[scope]
                        return (
                          <Badge key={scope} variant="secondary">
                            {label ? t(label) : scope}
                          </Badge>
                        )
                      })}
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setRevokeTarget(grant)}>
                    {t("settings.mcpRevoke")}
                  </Button>
                </div>
              ))
            )}
          </Card>
        </Group>
      )}

      {section === "encryption" && (
        <>
          <Group description={t("settings.vaultDesc")}>
            <Card>
              {clientIdentity && (
                <Row
                  label={t("settings.browserKey")}
                  hint={fingerprints[clientIdentity.publicKey] ? `${t("settings.fingerprint")} ${fingerprints[clientIdentity.publicKey]}` : undefined}
                >
                  <Button variant="outline" size="sm" onClick={() => copy(clientIdentity.publicKey)}>
                    {t("settings.copyPublicKey")}
                  </Button>
                </Row>
              )}
            </Card>
          </Group>
          <Group title={t("settings.pinnedDevices")}>
            <Card>
              {trusts.length === 0 ? (
                <Note>{t("settings.noPinnedDevices")}</Note>
              ) : (
                trusts.map((trust) => (
                  <Row
                    key={trust.device_id}
                    label={trust.device_name_hint || trust.device_id}
                    hint={fingerprints[trust.device_pub] ? `${t("settings.fingerprint")} ${fingerprints[trust.device_pub]}` : undefined}
                  >
                    <Button variant="outline" size="sm" onClick={() => void removeLocalDeviceTrust(trust.device_id)}>
                      {t("settings.unpairDevice")}
                    </Button>
                  </Row>
                ))
              )}
            </Card>
          </Group>
          <Group>
            <Card>
              <Row label={t("settings.resetVault")} hint={t("settings.resetVaultDesc")}>
                <Button variant="destructive" size="sm" onClick={() => setResetOpen(true)}>
                  {t("settings.resetVaultAction")}
                </Button>
              </Row>
            </Card>
          </Group>
        </>
      )}

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        onOpenChange={(o) => {
          if (!o) setRevokeTarget(null)
        }}
        title={revokeTarget?.client_name ?? ""}
        description={t("settings.mcpRevokeConfirm")}
        confirmLabel={t("settings.mcpRevoke")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={async () => {
          if (!activeAccount || !revokeTarget) return
          const tok = await getFreshAccessToken()
          await revokeMcpGrant(activeAccount.serverUrl, tok, revokeTarget.id)
          setRevokeTarget(null)
          await load()
          toast.success(t("common.saved"))
        }}
      />
      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={t("settings.resetVault")}
        description={t("settings.resetVaultConfirm")}
        confirmLabel={t("settings.resetVaultAction")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={async () => {
          await resetBrowserVault()
          setResetOpen(false)
          toast.success(t("common.saved"))
        }}
      />
    </div>
  )
}
