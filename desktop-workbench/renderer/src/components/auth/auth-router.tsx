"use client"

import { Suspense } from "react"
import { AuthProvider, useAuth } from "./auth-context"
import { BootstrapScreen } from "./bootstrap-screen"
import { LoginScreen } from "./login-screen"
import { RegisterScreen } from "./register-screen"
import { OAuthNewUserScreen } from "./oauth-new-user-screen"
import { OAuthLinkExistingScreen } from "./oauth-link-existing-screen"
import { SignedOutScreen } from "./signed-out-screen"
import { MobileOAuthFlow } from "./mobile-oauth-page"
import { Demo } from "@/components/demo"
import { FilePreviewPage } from "@/components/file-preview-page"
import { LoadingState } from "@/components/loading-state"

function AuthRouterInner() {
  const { screen, loading, isAuthenticated } = useAuth()

  if (loading) {
    return (
      <LoadingState className="min-h-screen bg-background" />
    )
  }
  if (screen === "bootstrap") return <BootstrapScreen />
  if (screen === "app") return isAuthenticated ? <Demo /> : <LoginScreen />
  if (screen === "signed-out") return <SignedOutScreen />
  if (screen === "register") return <RegisterScreen />
  if (screen === "oauth-new-user") return <OAuthNewUserScreen />
  if (screen === "oauth-link-existing") return <OAuthLinkExistingScreen />
  if (screen === "mobile-oauth") return <MobileOAuthFlow />
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
      <AuthRouterInner />
    </AuthProvider>
  )
}
