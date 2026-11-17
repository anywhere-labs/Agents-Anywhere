"use client"

import { LogOut, MonitorSmartphone } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useAuth } from "./auth-context"
import { AuthShell } from "./auth-shell"

/** Shown instead of sign-in and the workspace when the server requires end-to-end encryption and denies Web. */
export function E2eeWebUnavailableScreen() {
  const t = useTranslations("auth.e2eeWebUnavailable")
  const { isAuthenticated, signOut } = useAuth()

  return (
    <AuthShell>
      <div className="mx-auto flex w-full max-w-sm flex-col items-center text-center" data-testid="e2ee-web-unavailable">
        <div className="mb-5 flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <MonitorSmartphone className="size-7" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{t("description")}</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("useApps")}</p>
        {isAuthenticated ? (
          <Button variant="outline" className="mt-8 w-full" onClick={signOut}>
            <LogOut data-icon="inline-start" />
            {t("signOut")}
          </Button>
        ) : null}
      </div>
    </AuthShell>
  )
}
