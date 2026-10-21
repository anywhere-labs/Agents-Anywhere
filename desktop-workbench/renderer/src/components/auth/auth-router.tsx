"use client"

import { LocalOwnershipGate } from "@/features/desktop/local-ownership-gate"
import { Suspense } from "react"
import { AuthProvider, useAuth } from "./auth-context"
import { LoginScreen } from "./login-screen"
import { SignedOutScreen } from "./signed-out-screen"
import { Demo } from "@/components/demo"
import { FilePreviewPage } from "@/components/file-preview-page"
import { LoadingState } from "@/components/loading-state"
import { DesktopOnboardingPage } from "@/components/onboarding/desktop-onboarding-page"
import { SessionToolSidebarStateProvider } from "@/components/session-tool-sidebar-state"
import { DesktopUpdateProvider } from "@/features/desktop/desktop-update-provider"
import { AnnouncementGate } from "@/components/announcements/announcement-gate"

function AuthRouterInner() {
  const { screen, loading, isAuthenticated } = useAuth()

  if (loading) {
    return (
      <LoadingState className="min-h-screen bg-background" />
    )
  }
  if (screen === "app") return isAuthenticated ? <Demo /> : <LoginScreen />
  if (screen === "signed-out") return <SignedOutScreen />
  if (screen === "onboarding") return <DesktopOnboardingPage />
  if (screen === "preview") {
    return (
      <Suspense fallback={null}>
        <FilePreviewPage />
      </Suspense>
    )
  }
  return <LoginScreen />
}

export function AuthRouter() {
  return (
    <LocalOwnershipGate>
      <AuthProvider>
        <DesktopUpdateProvider>
          <SessionToolSidebarStateProvider>
            <AuthRouterContent />
          </SessionToolSidebarStateProvider>
        </DesktopUpdateProvider>
      </AuthProvider>
    </LocalOwnershipGate>
  )
}

function AuthRouterContent() {
  const { screen, loading } = useAuth()
  return <><AuthRouterInner /><AnnouncementGate page={loading ? null : screen} /></>
}
