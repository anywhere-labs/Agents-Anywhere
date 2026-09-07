"use client"

import { Suspense } from "react"
import { AuthProvider, useAuth } from "./auth-context"
import { LoginScreen } from "./login-screen"
import { SignedOutScreen } from "./signed-out-screen"
import { Demo } from "@/components/demo"
import { FilePreviewPage } from "@/components/file-preview-page"
import { LoadingState } from "@/components/loading-state"
import { SessionToolSidebarStateProvider } from "@/components/session-tool-sidebar-state"
import { DesktopUpdateProvider } from "@/features/desktop/desktop-update-provider"

function AuthRouterInner() {
  const { screen, loading, isAuthenticated } = useAuth()

  if (loading) {
    return (
      <LoadingState className="min-h-screen bg-background" />
    )
  }
  if (screen === "app") return isAuthenticated ? <Demo /> : <LoginScreen />
  if (screen === "signed-out") return <SignedOutScreen />
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
    <AuthProvider>
      <DesktopUpdateProvider>
        <SessionToolSidebarStateProvider>
          <AuthRouterInner />
        </SessionToolSidebarStateProvider>
      </DesktopUpdateProvider>
    </AuthProvider>
  )
}
