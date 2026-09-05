"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useAuth } from "@/components/auth/auth-context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
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
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Spinner } from "@/components/ui/spinner"
import { authApi } from "@/features/auth/api"
import type { EmailSettings, InstanceSettings } from "@/features/auth/types"

export function ServiceEmailCard({
  settings,
  token,
  isAdmin,
  onSaved,
}: {
  settings: EmailSettings
  token: string
  isAdmin: boolean
  onSaved: (settings: InstanceSettings) => void
}) {
  const t = useTranslations("pages.service.email")
  const { refreshConfig } = useAuth()
  const [enabled, setEnabled] = useState(settings.enabled)
  const [fromAddress, setFromAddress] = useState(settings.fromAddress)
  const [apiKey, setApiKey] = useState("")
  const [clearApiKey, setClearApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setEnabled(settings.enabled)
    setFromAddress(settings.fromAddress)
    setApiKey("")
    setClearApiKey(false)
  }, [settings])
  const dirty =
    enabled !== settings.enabled ||
    fromAddress.trim() !== settings.fromAddress ||
    Boolean(apiKey.trim()) ||
    clearApiKey
  const save = async () => {
    if (saving || !isAdmin || !token) return
    setSaving(true)
    try {
      const updated = await authApi.updateSettings(token, {
        email: {
          enabled,
          fromAddress: fromAddress.trim(),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(clearApiKey ? { clearApiKey: true } : {}),
        },
      })
      onSaved(updated)
      await refreshConfig()
      toast.success(t("saved"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("failed"))
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
        <FieldGroup>
          <Field orientation="horizontal" data-disabled={!isAdmin || saving}>
            <FieldContent>
              <FieldLabel htmlFor="email-enabled">{t("enabled")}</FieldLabel>
              <FieldDescription>{t("enabledDescription")}</FieldDescription>
            </FieldContent>
            <Switch
              id="email-enabled"
              checked={enabled}
              disabled={!isAdmin || saving}
              onCheckedChange={(value) => {
                setEnabled(value)
                if (value) setClearApiKey(false)
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="email-from">{t("fromAddress")}</FieldLabel>
            <Input
              id="email-from"
              value={fromAddress}
              placeholder="Agents Anywhere <accounts@example.com>"
              disabled={!isAdmin || saving}
              onChange={(event) => setFromAddress(event.currentTarget.value)}
            />
            <FieldDescription>{t("fromDescription")}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="email-api-key">{t("apiKey")}</FieldLabel>
            <Input
              id="email-api-key"
              type="password"
              autoComplete="new-password"
              value={apiKey}
              disabled={!isAdmin || saving || clearApiKey}
              onChange={(event) => setApiKey(event.currentTarget.value)}
            />
            <FieldDescription>{t("apiKeyDescription")}</FieldDescription>
            <Badge variant="secondary" className="self-start">
              {t(
                settings.apiKeyConfigured && !clearApiKey
                  ? "configured"
                  : "notConfigured",
              )}
            </Badge>
          </Field>
          {settings.apiKeyConfigured && !enabled ? (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="email-clear-key">
                  {t("clearKey")}
                </FieldLabel>
              </FieldContent>
              <Switch
                id="email-clear-key"
                checked={clearApiKey}
                disabled={!isAdmin || saving}
                onCheckedChange={(value) => {
                  setClearApiKey(value)
                  if (value) setApiKey("")
                }}
              />
            </Field>
          ) : null}
        </FieldGroup>
      </CardContent>
      <CardFooter>
        <Button
          type="button"
          disabled={
            !isAdmin ||
            saving ||
            !dirty ||
            (enabled &&
              (!fromAddress.trim() ||
                (!apiKey.trim() && !settings.apiKeyConfigured)))
          }
          onClick={() => void save()}
        >
          {saving ? <Spinner data-icon="inline-start" /> : null}
          {t("save")}
        </Button>
      </CardFooter>
    </Card>
  )
}
