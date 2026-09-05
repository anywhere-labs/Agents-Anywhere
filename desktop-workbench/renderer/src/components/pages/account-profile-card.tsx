"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useAuth } from "@/components/auth/auth-context"
import {
  EmailCodeField,
  DisplayNameField,
} from "@/components/auth/account-identity-fields"
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
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { authApi } from "@/features/auth/api"
import {
  isValidEmail,
  isValidDisplayName,
  normalizeEmail,
} from "@/features/auth/account-profile"
import type { AuthMe } from "@/features/auth/types"

export function AccountProfileCard({
  me,
  token,
  onMeChange,
}: {
  me: AuthMe
  token: string
  onMeChange: (me: AuthMe) => void
}) {
  const t = useTranslations("pages.settings.profile")
  const { emailVerificationRequired, refreshConfig } = useAuth()
  const [displayName, setDisplayName] = useState(me.displayName)
  const [email, setEmail] = useState(me.email ?? "")
  const [code, setCode] = useState("")
  const [saving, setSaving] = useState<"displayName" | "email" | null>(null)
  useEffect(() => {
    setDisplayName(me.displayName)
  }, [me.displayName])
  useEffect(() => {
    setEmail(me.email ?? "")
    setCode("")
  }, [me.email])
  useEffect(() => {
    void refreshConfig().catch(() => undefined)
  }, [refreshConfig])
  const save = async (kind: "displayName" | "email") => {
    if (saving || !token) return
    setSaving(kind)
    try {
      const updated =
        kind === "displayName"
          ? await authApi.updateProfile(token, displayName)
          : await authApi.updateEmail(token, email, code || undefined)
      onMeChange(updated)
      if (kind === "email") setCode("")
      toast.success(
        t(kind === "displayName" ? "displayNameSaved" : "emailSaved"),
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("failed"))
      void refreshConfig().catch(() => undefined)
    } finally {
      setSaving(null)
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
          <DisplayNameField
            value={displayName}
            onChange={setDisplayName}
            disabled={Boolean(saving)}
          />
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={
              Boolean(saving) ||
              !isValidDisplayName(displayName) ||
              displayName.trim() === me.displayName
            }
            onClick={() => void save("displayName")}
          >
            {saving === "displayName" ? (
              <Spinner data-icon="inline-start" />
            ) : null}
            {t("saveDisplayName")}
          </Button>
          <Field>
            <FieldLabel htmlFor="profile-email">{t("email")}</FieldLabel>
            <Input
              id="profile-email"
              type="email"
              autoComplete="email"
              value={email}
              disabled={Boolean(saving)}
              onChange={(event) => {
                setEmail(event.currentTarget.value)
                setCode("")
              }}
            />
            <FieldDescription>{t("emailDescription")}</FieldDescription>
            {me.email && normalizeEmail(email) === me.email ? (
              <Badge
                variant={me.emailVerified ? "secondary" : "outline"}
                className="self-start"
              >
                {t(me.emailVerified ? "verified" : "unverified")}
              </Badge>
            ) : null}
          </Field>
          {emailVerificationRequired ? (
            <EmailCodeField
              email={email}
              value={code}
              onChange={setCode}
              purpose="bind"
              token={token}
              disabled={Boolean(saving)}
              id="profile-email-code"
            />
          ) : (
            <FieldDescription>{t("verificationDisabled")}</FieldDescription>
          )}
        </FieldGroup>
      </CardContent>
      <CardFooter>
        <Button
          type="button"
          disabled={
            Boolean(saving) ||
            !isValidEmail(email) ||
            (normalizeEmail(email) === me.email && me.emailVerified) ||
            (emailVerificationRequired && code.length !== 6)
          }
          onClick={() => void save("email")}
        >
          {saving === "email" ? <Spinner data-icon="inline-start" /> : null}
          {t(me.email ? "changeEmail" : "bindEmail")}
        </Button>
      </CardFooter>
    </Card>
  )
}
