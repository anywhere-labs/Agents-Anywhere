"use client"

// Cloud Drive limits for one account: look the account up, see what applies to it, override space, largest file
// or retention, or go back to the defaults (`/admin/drive/policies/{user_id}`).
import { useState } from "react"
import { toast } from "sonner"

import { DetailList } from "@/components/console/detail-list"
import { PageContainer, PageHeader } from "@/components/console/page-header"
import { formatBytes } from "@/components/conversation/text"
import { Field } from "@/components/field"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { deleteAdminDrivePolicy, fetchAdminDrivePolicy, updateAdminDrivePolicy } from "@/lib/api/control-http"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { AdminDrivePolicyResponse } from "@/lib/types/v3"

const MB = 1024 * 1024
const DAY = 86400

export default function AdminDrivePage() {
  const { t, locale } = useI18n()
  const { activeAccount, getFreshAccessToken } = useWorkbench()
  const [userId, setUserId] = useState("")
  const [policy, setPolicy] = useState<AdminDrivePolicyResponse | null>(null)
  const [quotaMb, setQuotaMb] = useState("")
  const [maxFileMb, setMaxFileMb] = useState("")
  const [ttlDays, setTtlDays] = useState("")
  const [busy, setBusy] = useState(false)

  const show = (res: AdminDrivePolicyResponse) => {
    setPolicy(res)
    setQuotaMb(res.override?.quota_bytes ? String(Math.round(res.override.quota_bytes / MB)) : "")
    setMaxFileMb(res.override?.max_file_bytes ? String(Math.round(res.override.max_file_bytes / MB)) : "")
    setTtlDays(res.override?.default_ttl_seconds ? String(Math.round(res.override.default_ttl_seconds / DAY)) : "")
  }

  const run = async (fn: (token: string, server: string, id: string) => Promise<AdminDrivePolicyResponse>, saved: boolean) => {
    if (!activeAccount || !userId.trim()) return
    setBusy(true)
    try {
      show(await fn(await getFreshAccessToken(), activeAccount.serverUrl, userId.trim()))
      if (saved) toast.success(t("common.saved"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const size = (bytes: number | null | undefined) => (bytes && bytes > 0 ? formatBytes(bytes) : t("common.unlimited"))
  const days = (seconds: number | null | undefined) => {
    const n = Math.round((seconds ?? 0) / DAY)
    return locale === "zh-CN" ? `${n} 天` : `${n} days`
  }

  return (
    <PageContainer>
      <PageHeader title={t("admin.drive.title")} description={t("admin.drive.description")} />

      <form
        className="flex flex-wrap items-end gap-2 rounded-card bg-card p-6"
        onSubmit={(e) => {
          e.preventDefault()
          void run((tok, server, id) => fetchAdminDrivePolicy(server, tok, id), false)
        }}
      >
        <Field label={t("admin.drive.userId")} className="min-w-64 flex-1">
          <Input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="usr_…" />
        </Field>
        <Button type="submit" variant="outline" disabled={busy || !userId.trim()}>
          {t("admin.drive.lookup")}
        </Button>
      </form>

      {policy && (
        <>
          <section className="space-y-3">
            <h2 className="text-base font-semibold tracking-tight">{t("admin.drive.effective")}</h2>
            <div className="rounded-card bg-card p-6">
              <DetailList
                items={[
                  { key: "quota", label: t("settings.allowanceDriveQuota"), value: size(policy.effective.quota_bytes) },
                  { key: "maxFile", label: t("settings.allowanceMaxFile"), value: size(policy.effective.max_file_bytes) },
                  { key: "ttl", label: t("settings.allowanceDriveTtl"), value: days(policy.effective.default_ttl_seconds) },
                  { key: "used", label: t("admin.drive.used"), value: formatBytes(policy.effective.used_bytes) },
                ]}
              />
            </div>
          </section>

          <section className="space-y-3">
            <div className="space-y-1">
              <h2 className="text-base font-semibold tracking-tight">{t("admin.drive.override")}</h2>
              <p className="text-sm text-muted-foreground">{t("admin.drive.overrideHint")}</p>
            </div>
            <div className="space-y-5 rounded-card bg-card p-6">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label={t("admin.drive.quotaMb")}>
                  <Input type="number" min={0} value={quotaMb} onChange={(e) => setQuotaMb(e.target.value)} />
                </Field>
                <Field label={t("admin.drive.maxFileMb")}>
                  <Input type="number" min={0} value={maxFileMb} onChange={(e) => setMaxFileMb(e.target.value)} />
                </Field>
                <Field label={t("admin.drive.ttlDays")}>
                  <Input type="number" min={0} value={ttlDays} onChange={(e) => setTtlDays(e.target.value)} />
                </Field>
              </div>
              <div className="flex gap-2">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(
                      (tok, server, id) =>
                        updateAdminDrivePolicy(server, tok, id, {
                          quota_bytes: quotaMb ? Number(quotaMb) * MB : null,
                          max_file_bytes: maxFileMb ? Number(maxFileMb) * MB : null,
                          default_ttl_seconds: ttlDays ? Number(ttlDays) * DAY : null,
                        }),
                      true
                    )
                  }
                >
                  {t("common.save")}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !policy.override}
                  onClick={() => void run((tok, server, id) => deleteAdminDrivePolicy(server, tok, id), true)}
                >
                  {t("admin.drive.reset")}
                </Button>
              </div>
            </div>
          </section>
        </>
      )}
    </PageContainer>
  )
}
