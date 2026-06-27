"use client"

import { CheckCircle2, LogIn } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useAuth } from "./auth-context"
import { AuthShell } from "./auth-shell"

export function SignedOutScreen() {
  const t = useTranslations("auth.signedOut")
  const { navigate } = useAuth()

  return (
    <AuthShell>
      <div className="mx-auto flex w-full max-w-sm flex-col items-center text-center">
        <div className="mb-5 flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <CheckCircle2 className="size-7" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{t("description")}</p>
        <Button className="mt-8 w-full" onClick={() => navigate("login")}>
          <LogIn data-icon="inline-start" />
          {t("login")}
        </Button>
      </div>
    </AuthShell>
  )
}
