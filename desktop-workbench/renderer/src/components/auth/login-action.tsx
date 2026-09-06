"use client"

import { Cloud, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTranslations } from "next-intl"

type LoginActionProps = {
  loading: boolean
  disabled?: boolean
  startLogin: () => Promise<void>
}

export function LoginAction({ loading, disabled, startLogin }: LoginActionProps) {
  const t = useTranslations("auth")
  return (
      <Button
        className="h-10 w-full gap-2 rounded-lg"
        disabled={disabled || loading}
        onClick={() => void startLogin()}
      >
        {loading ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Cloud data-icon="inline-start" />}
        {t(loading ? "login.connecting" : "login.cloud")}
      </Button>
  )
}
