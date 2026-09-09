"use client"

import * as React from "react"
import { Eye, EyeOff } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useAuth } from "@/components/auth/auth-context"
import { OnboardingShell } from "@/components/onboarding/reference/components/onboarding-shell"
import { PhoneSlide } from "@/components/onboarding/reference/slides/phone"
import { MobileConnectionDialog } from "@/components/pages/mobile-signin-panel"
import { Button } from "@/components/ui/button"
import { accountDisplayName } from "@/features/auth/account-profile"
import { useMobileConnectionsSidebarVisibility } from "@/features/mobile-connections/sidebar-visibility"
import "@/components/onboarding/reference/styles/onboarding.css"

export function MobileConnectionsPage() {
  const t = useTranslations("dashboard.mobileConnections")
  const { session, me } = useAuth()
  const [sidebarVisible, setSidebarVisible] = useMobileConnectionsSidebarVisibility()
  const [dialogOpen, setDialogOpen] = React.useState(false)

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

      {/* The onboarding flow's own phone slide, embedded in the page area. */}
      <div className="onboarding-viewport onboarding-viewport-embedded">
        <OnboardingShell artwork="phone" wordmark={false}>
          <div className="slide-page">
            <PhoneSlide onConnect={() => setDialogOpen(true)} />
          </div>
        </OnboardingShell>
      </div>

      <MobileConnectionDialog
        token={session?.accessToken ?? ""}
        userId={me ? accountDisplayName(me) : session?.userId ?? ""}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  )
}
