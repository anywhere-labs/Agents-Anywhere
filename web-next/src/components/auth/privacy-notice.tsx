"use client"

import { useTranslations } from "next-intl"

/**
 * One policy link for every screen that opens or creates a session, so a user
 * always sees it before signing in or registering an account.
 */
export function PrivacyNotice({ message }: { message: string }) {
  const t = useTranslations("privacy")
  return (
    <p className="text-center text-xs text-muted-foreground">
      {message}{" "}
      <a
        href="/privacy"
        className="font-medium text-foreground underline-offset-4 hover:underline"
      >
        {t("title")}
      </a>
    </p>
  )
}
