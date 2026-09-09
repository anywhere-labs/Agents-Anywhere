"use client"

import { ArrowRight, Eye, EyeOff } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useAuth } from "@/components/auth/auth-context"
import { MobileConnectionDialog } from "@/components/pages/mobile-signin-panel"
import { Button } from "@/components/ui/button"
import { accountDisplayName } from "@/features/auth/account-profile"
import { useMobileConnectionsSidebarVisibility } from "@/features/mobile-connections/sidebar-visibility"

export function MobileConnectionsPage() {
  const t = useTranslations("dashboard.mobileConnections")
  const { session, me } = useAuth()
  const [sidebarVisible, setSidebarVisible] = useMobileConnectionsSidebarVisibility()

  const toggleSidebarVisibility = () => {
    const nextVisible = !sidebarVisible
    setSidebarVisible(nextVisible)
    toast.success(t(nextVisible ? "shownToast" : "hiddenToast"))
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <div className="absolute right-3 top-3 z-10 rounded-md bg-background">
        <Button type="button" variant="ghost" size="sm" onClick={toggleSidebarVisibility}>
          {sidebarVisible ? <EyeOff data-icon="inline-start" /> : <Eye data-icon="inline-start" />}
          {t(sidebarVisible ? "hideFromSidebar" : "showInSidebar")}
        </Button>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {/* Same type scale, spacing and artwork treatment as the onboarding slides. */}
        <div className="mx-auto grid min-h-full w-full max-w-[88rem] items-center gap-12 px-6 py-12 md:px-8 xl:grid-cols-2 xl:px-10 2xl:gap-20 2xl:px-12">
          <section className="flex max-w-[42rem] flex-col items-start gap-9">
            <div className="flex flex-col gap-6">
              <h2 className="text-pretty text-[clamp(2.5rem,4.6vw,4rem)] font-medium leading-[1.16] tracking-[-0.055em]">
                {t("heroTitle")}
              </h2>
              <p className="max-w-xl text-pretty text-[17px] leading-[1.85] text-muted-foreground">
                {t("heroDescription")}
              </p>
            </div>
            <MobileConnectionDialog
              token={session?.accessToken ?? ""}
              userId={me ? accountDisplayName(me) : session?.userId ?? ""}
            >
              <Button type="button" size="lg">
                {t("connect")}
                <ArrowRight data-icon="inline-end" />
              </Button>
            </MobileConnectionDialog>
          </section>

          <div className="mx-auto w-full max-w-[36rem]">
            <img
              src="/mobile-connections-preview.png"
              alt={t("previewAlt")}
              className="block h-auto w-full drop-shadow-[12px_16px_28px_color-mix(in_oklch,var(--foreground)_5%,transparent)]"
              width={1920}
              height={1440}
            />
          </div>
        </div>
      </main>
    </div>
  )
}
