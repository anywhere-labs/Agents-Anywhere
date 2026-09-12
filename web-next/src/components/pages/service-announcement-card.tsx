"use client"

import { useEffect, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { toast } from "sonner"
import { MarkdownText } from "@/components/markdown-text"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { announcementsApi } from "@/features/announcements/api"
import type { AnnouncementSettings } from "@/features/announcements/types"

export function ServiceAnnouncementCard({ token }: { token: string }) {
  const t = useTranslations("announcement.admin")
  const format = useFormatter()
  const [saved, setSaved] = useState<AnnouncementSettings | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [markdown, setMarkdown] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    announcementsApi.settings(token).then(value => {
      if (cancelled) return
      setSaved(value); setEnabled(value.enabled); setMarkdown(value.markdown)
    }).catch(() => { if (!cancelled) setError(t("loadFailed")) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token, reload, t])

  const invalid = enabled && !markdown.trim()
  const dirty = saved !== null && (enabled !== saved.enabled || markdown !== saved.markdown)
  const save = async () => {
    if (!dirty || invalid || saving) return
    setSaving(true); setError(null)
    try {
      const updated = await announcementsApi.save(token, { enabled, markdown })
      setSaved(updated); setEnabled(updated.enabled); setMarkdown(updated.markdown)
      toast.success(t("saved"))
    } catch {
      setError(t("saveFailed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? <Spinner aria-label={t("loading")} /> : (
          <FieldGroup>
            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
            {saved && <>
              <Field orientation="horizontal" data-disabled={saving}>
                <FieldContent>
                  <FieldLabel htmlFor="announcement-enabled">{t("enabled")}</FieldLabel>
                  <FieldDescription>{t("enabledHint")}</FieldDescription>
                </FieldContent>
                <Switch id="announcement-enabled" checked={enabled} onCheckedChange={setEnabled} disabled={saving} />
              </Field>
              <Field data-invalid={invalid} data-disabled={saving}>
                <FieldLabel htmlFor="announcement-markdown">{t("content")}</FieldLabel>
                <Textarea id="announcement-markdown" value={markdown} onChange={event => setMarkdown(event.target.value)}
                  className="min-h-48 max-h-80" rows={9} maxLength={20_000} disabled={saving} aria-invalid={invalid}
                  aria-describedby="announcement-content-hint" placeholder={t("placeholder")} />
                <FieldDescription id="announcement-content-hint">{invalid ? t("contentRequired") : t("contentHint")}</FieldDescription>
              </Field>
              {markdown.trim() && <Field>
                <FieldLabel>{t("preview")}</FieldLabel>
                <div className="max-h-72 overflow-y-auto rounded-lg border p-4 [overflow-wrap:anywhere]">
                  <MarkdownText text={markdown} />
                </div>
              </Field>}
            </>}
          </FieldGroup>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap justify-between gap-3">
        <p className="text-sm text-muted-foreground">{saved?.publishedAt
          ? t("publishedAt", { time: format.dateTime(new Date(saved.publishedAt), { dateStyle: "medium", timeStyle: "short" }) })
          : t("notPublished")}</p>
        {!saved && error
          ? <Button variant="outline" onClick={() => setReload(value => value + 1)}>{t("retry")}</Button>
          : <Button disabled={loading || saving || !dirty || invalid} onClick={() => void save()}>
            {saving && <Spinner />}{t("save")}
          </Button>}
      </CardFooter>
    </Card>
  )
}
