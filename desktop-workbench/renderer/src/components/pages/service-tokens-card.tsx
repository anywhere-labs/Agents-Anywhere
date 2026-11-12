"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { modelConfigApi, type TokensAdminSettings } from "@/features/model-config/api"
import { isApiError } from "@/lib/api/errors"

/** The Tokens Anywhere address users link their accounts to. */
export function ServiceTokensCard({ token, isAdmin }: { token: string; isAdmin: boolean }) {
  const t = useTranslations("pages.service.tokens")
  const [saved, setSaved] = useState<TokensAdminSettings | null>(null)
  const [url, setUrl] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!token) return
    let cancelled = false
    setLoading(true)
    setError(null)
    modelConfigApi.adminTokensSettings(token).then((value) => {
      if (cancelled) return
      setSaved(value)
      setUrl(value.tokensUrl ?? "")
    }).catch(() => { if (!cancelled) setError(t("loadFailed")) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token, reload, t])

  const dirty = saved !== null && url.trim() !== (saved.tokensUrl ?? "")
  // Accounts linked to the current address must unlink before it changes.
  const locked = Boolean(saved?.linkedAccounts)
  const save = async () => {
    if (!dirty || saving) return
    setSaving(true)
    setError(null)
    try {
      const updated = await modelConfigApi.saveAdminTokensSettings(token, url.trim())
      setSaved(updated)
      setUrl(updated.tokensUrl ?? "")
      toast.success(updated.tokensUrl ? t("saved") : t("turnedOff"))
    } catch (failure) {
      const code = isApiError(failure) ? failure.code : null
      setError(code && t.has(`errors.${code}`) ? t(`errors.${code}`) : t("saveFailed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tokens Anywhere</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? <Spinner /> : (
          <FieldGroup>
            {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            {saved && !saved.secretConfigured ? <Alert><AlertDescription>{t("secretMissing")}</AlertDescription></Alert> : null}
            {saved ? (
              <Field data-disabled={saving || locked || !isAdmin}>
                <FieldLabel htmlFor="tokens-url">{t("address")}</FieldLabel>
                <Input
                  id="tokens-url"
                  type="url"
                  inputMode="url"
                  value={url}
                  placeholder="https://tokens.example.com"
                  maxLength={2048}
                  disabled={saving || locked || !isAdmin}
                  onChange={(event) => setUrl(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void save() }}
                />
                <FieldDescription>
                  {locked ? t("lockedByLinks", { count: saved.linkedAccounts }) : t("addressHint")}
                </FieldDescription>
              </Field>
            ) : null}
          </FieldGroup>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {saved?.source === "environment" ? t("fromEnvironment") : saved?.tokensUrl ? t("fromSetting") : saved ? t("off") : null}
        </p>
        {!saved && error ? (
          <Button variant="outline" onClick={() => setReload((value) => value + 1)}>{t("retry")}</Button>
        ) : (
          <Button disabled={!isAdmin || loading || saving || locked || !dirty} onClick={() => void save()}>
            {saving ? <Spinner /> : null}{t("save")}
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}
