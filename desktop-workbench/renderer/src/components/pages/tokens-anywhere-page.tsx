"use client"

import { ArrowRight, Eye, EyeOff } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { DashboardSidebarToggle } from "@/components/dashboard-sidebar-toggle"
import { OnboardingShell } from "@/components/onboarding/reference/components/onboarding-shell"
import { SlideFrame } from "@/components/onboarding/reference/components/slide-frame"
import { Button as SlideButton } from "@/components/onboarding/reference/components/ui/button"
import { Button } from "@/components/ui/button"
import { TokensAnywhereArtwork } from "@/features/tokens-anywhere/artwork"
import { useTokensAnywhereSidebarVisibility } from "@/features/tokens-anywhere/sidebar-visibility"
import { PRODUCT_LINKS } from "@/lib/product-links"
import "@/components/onboarding/reference/styles/onboarding.css"

export function TokensAnywherePage() {
  const t = useTranslations("dashboard.tokensAnywhere")
  const [sidebarVisible, setSidebarVisible] = useTokensAnywhereSidebarVisibility()
  // Signed-out visitors sign in there first, then land on their keys.
  const apiKeysUrl = tokensAnywherePage("/console/api-keys/")

  const toggleSidebarVisibility = () => {
    const nextVisible = !sidebarVisible
    setSidebarVisible(nextVisible)
    toast.success(t(nextVisible ? "shownToast" : "hiddenToast"))
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <div className="absolute left-3 top-3.5 z-10">
        <DashboardSidebarToggle showOnDesktop />
      </div>
      <div className="absolute right-3 top-3 z-10 rounded-md bg-background">
        <Button type="button" variant="ghost" size="sm" onClick={toggleSidebarVisibility}>
          {sidebarVisible ? <EyeOff data-icon="inline-start" /> : <Eye data-icon="inline-start" />}
          {t(sidebarVisible ? "hideFromSidebar" : "showInSidebar")}
        </Button>
      </div>

      <div className="onboarding-viewport onboarding-viewport-embedded">
        <OnboardingShell artwork="phone" wordmark={false}>
          <div className="slide-page">
            <SlideFrame
              id="tokens-anywhere"
              title={t("headline")}
              description={t("description")}
              artwork={<div className="-mx-6"><TokensAnywhereArtwork /></div>}
              actions={apiKeysUrl ? (
                <SlideButton asChild size="lg">
                  <a href={apiKeysUrl} target="_blank" rel="noopener noreferrer">
                    {t("getApiKey")}<ArrowRight data-icon="inline-end" />
                  </a>
                </SlideButton>
              ) : <p className="text-sm text-muted-foreground">{t("unavailable")}</p>}
            />
          </div>
        </OnboardingShell>
      </div>
    </div>
  )
}

function tokensAnywherePage(path: string): string | null {
  try {
    return new URL(path, PRODUCT_LINKS.tokensAnywhereUrl).href
  } catch {
    return null
  }
}
