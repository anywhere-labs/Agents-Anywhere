"use client"

import { Bug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useLocale } from "next-intl"

type LoginActionProps = {
  loading: boolean
  startLogin: () => Promise<void>
}

export function LoginAction({ loading, startLogin }: LoginActionProps) {
  const isChinese = useLocale().toLowerCase().startsWith("zh")
  return (
    <div className="flex flex-col gap-5 text-center">
      <p className="text-sm leading-relaxed text-muted-foreground">
        {isChinese
          ? "在独立窗口中使用 Web 登录页完成开发环境登录。"
          : "Use the Web sign-in page in a separate window for development."}
      </p>
      <Button
        className="h-11 w-full gap-2 font-medium"
        disabled={loading}
        onClick={() => void startLogin().catch(() => undefined)}
      >
        <Bug className="size-4" />
        {isChinese ? "开发模式登录" : "Development sign-in"}
      </Button>
    </div>
  )
}
