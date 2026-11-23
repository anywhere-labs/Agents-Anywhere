"use client"

// 设置, from the account menu at the bottom left (or ⌘,): a large dialog with its own section list, like Effi's and
// Claude's settings. Phones get it full screen: the section list first, a section opens as its own page with a back
// button. Administration is not here: it has its own console at /admin (anywhere-ui console template).
import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  CloudIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LockIcon,
  MonitorIcon,
  MoonIcon,
  SlidersHorizontalIcon,
  SunIcon,
  UserIcon,
  XIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { toast } from "sonner"

import { ConfirmDialog } from "@/components/console/confirm-dialog"
import { DetailList, type DetailItem } from "@/components/console/detail-list"
import { formatBytes } from "@/components/conversation/text"
import { DropdownSelect } from "@/components/dropdown-select"
import { useI18n } from "@/components/i18n-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { useIsMobile } from "@/hooks/use-mobile"
import { fetchAuthConfig, listDriveFiles, listMcpGrants, revokeMcpGrant } from "@/lib/api/control-http"
import type { Locale, MessageKey } from "@/lib/i18n"
import { formatKeyFingerprint } from "@/lib/mesh/pairing"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { DriveQuotaView, McpGrantView } from "@/lib/types/v3"
import { cn } from "@/lib/utils"
import { Card, Group, Note, Row } from "@/components/workbench/settings-parts"

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
  const phone = useIsMobile()
  const shown = section ?? "general"
  const showList = phone && section === null
  const title = t(SECTIONS.find((s) => s.id === shown)!.label)

  const nav = (
    <nav aria-label={t("settings.title")} className={cn("flex flex-col gap-0.5", phone ? "px-4 pt-4 pb-8" : "px-3 pb-4")}>
      {SECTIONS.map(({ id, label, Icon }) => {
        const current = !phone && shown === id
        return (
          <button
            key={id}
            type="button"
            aria-current={current ? "page" : undefined}
            onClick={() => onSection(id)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-full text-left text-sm transition-colors",
              phone ? "h-12 px-3" : "h-9 px-3",
              current ? "bg-surface-hover font-medium text-foreground" : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t(label)}</span>
            {phone && <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />}
          </button>
        )
      })}
    </nav>
  )

  const body = <SettingsBody section={shown} active={open} onClose={() => onOpenChange(false)} />

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "flex gap-0 overflow-hidden p-0",
          phone
            ? "top-0 left-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 rounded-none sm:max-w-none"
            : "h-[min(680px,calc(100dvh-4rem))] w-[calc(100%-3rem)] max-w-[56rem] sm:max-w-[56rem]"
        )}
      >
        <DialogDescription className="sr-only">{t("settings.dialogDesc")}</DialogDescription>
        {phone ? (
          <div className="flex min-w-0 flex-1 flex-col" style={{ paddingTop: "env(safe-area-inset-top)" }}>
            <header className="flex h-14 shrink-0 items-center gap-1 px-2">
              {showList ? (
                <DialogTitle className="flex-1 px-2 text-base font-semibold">{t("settings.title")}</DialogTitle>
              ) : (
                <>
                  <Button variant="ghost" size="icon-sm" aria-label={t("common.back")} onClick={() => onSection(null)}>
                    <ArrowLeftIcon />
                  </Button>
                  <DialogTitle className="flex-1 truncate text-base font-semibold">{title}</DialogTitle>
                </>
              )}
              <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label={t("common.close")} />}>
                <XIcon />
              </DialogClose>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {showList ? nav : <div className="px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))]">{body}</div>}
            </div>
          </div>
        ) : (
          <>
            <aside className="flex w-56 shrink-0 flex-col overflow-y-auto bg-card">
              <DialogTitle className="px-6 pt-6 pb-4 text-base font-semibold">{t("settings.title")}</DialogTitle>
              {nav}
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
              <header className="flex h-16 shrink-0 items-center gap-2 pr-4 pl-8">
                <h2 className="flex-1 truncate text-base font-semibold">{title}</h2>
                <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label={t("common.close")} />}>
                  <XIcon />
                </DialogClose>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                <div className="mx-auto w-full max-w-2xl px-8 pb-10">{body}</div>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
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
    removeLocalDeviceTrust,
    resetBrowserVault,
  } = useWorkbench()

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
              <Row
                label={t("settings.driveUsedLabel")}
                hint={t("settings.driveUsedHint", {
                  used: formatBytes(driveQuota.used_bytes),
                  total: sizeOrUnlimited(driveQuota.quota_bytes, t("common.unlimited")),
                  count: driveQuota.file_count,
                })}
              >
                <Button variant="outline" size="sm" render={<Link href="/drive" onClick={onClose} />} nativeButton={false}>
                  {t("settings.openDrive")}
                </Button>
              </Row>
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
