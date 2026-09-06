"use client"

import { Globe } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTranslations } from "next-intl"

type LoginActionProps = {
  loading: boolean
  startLogin: () => Promise<void>
}

export function LoginAction({ loading, startLogin }: LoginActionProps) {
  const t = useTranslations("auth")
  return (
    <div className="flex flex-col gap-5 text-center">
      <p className="text-sm leading-relaxed text-muted-foreground">
        {t("login.oauthDescription")}
      </p>
      <Button
        className="h-11 w-full gap-2 font-medium"
        disabled={loading}
        onClick={() => void startLogin().catch(() => undefined)}
      >
        <Globe className="size-4" />
        {t("login.desktopOAuth")}
      </Button>
    </div>
  )
}
