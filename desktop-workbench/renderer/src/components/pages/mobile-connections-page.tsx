"use client"

import * as React from "react"
import { ArrowRight, EyeOff, Smartphone } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useAuth } from "@/components/auth/auth-context"
import { DashboardSidebarToggle } from "@/components/dashboard-sidebar-toggle"
import { MobileConnectionOnboarding } from "@/components/pages/mobile-signin-panel"
import { Button } from "@/components/ui/button"
import { useWorkspace } from "@/components/workspace-context"
import { useMobileConnectionsSidebarVisibility } from "@/features/mobile-connections/sidebar-visibility"

export function MobileConnectionsPage() {
  const t = useTranslations("dashboard.mobileConnections")
  const { session } = useAuth()
  const { replaceHome } = useWorkspace()
  const [sidebarVisible, setSidebarVisible] = useMobileConnectionsSidebarVisibility()
  const [connecting, setConnecting] = React.useState(false)

  const hideFromSidebar = () => {
    setSidebarVisible(false)
    toast.success(t("hiddenToast"))
    replaceHome()
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 px-3">
        <div className="flex min-w-0 items-center gap-3">
          <DashboardSidebarToggle />
          <h1 className="truncate text-sm font-semibold">{t("title")}</h1>
        </div>
        {sidebarVisible ? (
          <Button type="button" variant="ghost" size="sm" onClick={hideFromSidebar}>
            <EyeOff data-icon="inline-start" />
            {t("hideFromSidebar")}
          </Button>
        ) : null}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {connecting ? (
          <div className="mx-auto flex min-h-full w-full max-w-2xl items-center px-5 py-10 sm:px-8">
            <MobileConnectionOnboarding
              token={session?.accessToken ?? ""}
              userId={session?.userId ?? ""}
              autoStart
              onDone={() => setConnecting(false)}
              onExit={() => setConnecting(false)}
            />
          </div>
        ) : (
          <div className="mx-auto grid min-h-full w-full max-w-7xl items-center gap-10 px-6 py-10 md:px-10 xl:grid-cols-[minmax(0,0.82fr)_minmax(30rem,1.18fr)] xl:gap-16 xl:px-12">
            <section className="flex max-w-xl flex-col items-start gap-6">
              <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                <Smartphone className="size-3.5" />
                {t("heroEyebrow")}
              </div>
              <div className="flex flex-col gap-4">
                <h2 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
                  {t("heroTitle")}
                </h2>
                <p className="max-w-lg text-pretty text-base leading-7 text-muted-foreground sm:text-lg">
                  {t("heroDescription")}
                </p>
              </div>
              <Button type="button" size="lg" onClick={() => setConnecting(true)}>
                {t("connect")}
                <ArrowRight data-icon="inline-end" />
              </Button>
            </section>

            <div className="mx-auto w-full max-w-3xl overflow-hidden rounded-[2rem] border border-border bg-muted/30 shadow-2xl shadow-foreground/10 xl:max-w-none">
              <img
                src="/mobile-connections-preview.png"
                alt={t("previewAlt")}
                className="block h-auto w-full"
                width={1920}
                height={1440}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
