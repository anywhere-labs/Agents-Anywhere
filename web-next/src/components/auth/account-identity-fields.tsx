"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { authApi } from "@/features/auth/api"
import {
  isValidEmail,
  isValidDisplayName,
  normalizeEmail,
} from "@/features/auth/account-profile"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"

export function DisplayNameField({
  value,
  onChange,
  id = "account-displayName",
  disabled = false,
}: {
  value: string
  onChange: (value: string) => void
  id?: string
  disabled?: boolean
}) {
  const t = useTranslations("auth")
  const invalid = Boolean(value && !isValidDisplayName(value))
  return (
    <Field data-invalid={invalid} data-disabled={disabled}>
      <FieldLabel htmlFor={id}>{t("fields.displayName")}</FieldLabel>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        autoComplete="nickname"
        maxLength={64}
        required
        disabled={disabled}
        aria-invalid={invalid}
      />
      <FieldDescription>{t("fields.displayNameDescription")}</FieldDescription>
    </Field>
  )
}

export function EmailCodeField({
  email,
  value,
  onChange,
  purpose = "register",
  token,
  pendingToken,
  setupToken,
  disabled = false,
  id = "email-code",
}: {
  email: string
  value: string
  onChange: (value: string) => void
  purpose?: "register" | "bind"
  token?: string
  pendingToken?: string
  setupToken?: string
  disabled?: boolean
  id?: string
}) {
  const t = useTranslations("auth.emailCode")
  const currentEmail = useRef(normalizeEmail(email))
  const [sending, setSending] = useState(false)
  const [retryAfter, setRetryAfter] = useState(0)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    currentEmail.current = normalizeEmail(email)
    setSent(false)
    setError(null)
  }, [email])
  useEffect(() => {
    if (retryAfter <= 0) return
    const timer = window.setInterval(
      () => setRetryAfter((value) => Math.max(0, value - 1)),
      1000,
    )
    return () => window.clearInterval(timer)
  }, [retryAfter])
  const send = async () => {
    if (sending || retryAfter || !isValidEmail(email)) return
    const requestedEmail = normalizeEmail(email)
    setSending(true)
    setError(null)
    try {
      const result = await authApi.sendEmailCode(
        email,
        purpose,
        token,
        pendingToken,
        setupToken,
      )
      setRetryAfter(result.retryAfter)
      if (currentEmail.current === requestedEmail) setSent(true)
    } catch (err) {
      if (currentEmail.current === requestedEmail)
        setError(err instanceof Error ? err.message : t("failed"))
    } finally {
      setSending(false)
    }
  }
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t("label")}</FieldLabel>
      <div className="flex flex-wrap gap-2">
        <Input
          id={id}
          value={value}
          onChange={(event) =>
            onChange(event.currentTarget.value.replace(/\D/g, "").slice(0, 6))
          }
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          disabled={disabled}
          className="min-w-32 flex-1"
        />
        <Button
          type="button"
          variant="outline"
          disabled={
            disabled || sending || retryAfter > 0 || !isValidEmail(email)
          }
          onClick={() => void send()}
        >
          {sending ? <Spinner data-icon="inline-start" /> : null}
          {retryAfter > 0 ? t("retry", { seconds: retryAfter }) : t("send")}
        </Button>
      </div>
      <FieldDescription>{sent ? t("sent") : t("description")}</FieldDescription>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </Field>
  )
}
