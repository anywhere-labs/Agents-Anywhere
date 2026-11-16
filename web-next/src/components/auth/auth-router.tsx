"use client"

import { Suspense } from "react"
import { AuthProvider, useAuth } from "./auth-context"
import { BootstrapScreen } from "./bootstrap-screen"
import { LoginScreen } from "./login-screen"
import { RegisterScreen } from "./register-screen"
import { ForgotPasswordScreen } from "./forgot-password-screen"
import { OAuthNewUserScreen } from "./oauth-new-user-screen"
import { OAuthLinkExistingScreen } from "./oauth-link-existing-screen"
import { SignedOutScreen } from "./signed-out-screen"
import { E2eeWebUnavailableScreen } from "./e2ee-web-unavailable-screen"
import { TokensAnywhereOAuthFlow, DesktopOAuthFlow, MobileOAuthFlow, PluginOAuthFlow } from "./mobile-oauth-page"
import { PluginOnboardingPage } from "@/components/onboarding/plugin-onboarding-page"
import { Demo } from "@/components/demo"
import { FilePreviewPage } from "@/components/file-preview-page"
import { LoadingState } from "@/components/loading-state"
import { AnnouncementGate } from "@/components/announcements/announcement-gate"

/** Screens that sign in to or show the Web workspace itself. */
const WEB_WORKSPACE_SCREENS = new Set<string>(["app", "login", "register", "forgot-password", "signed-out", "oauth-new-user", "oauth-link-existing", "preview"])

function AuthRouterInner() {
  const { screen, loading, isAuthenticated, webDeniedByE2ee } = useAuth()

  if (loading) {
    return (
      <LoadingState className="min-h-screen bg-background" />
    )
  }
  if (screen === "bootstrap") return <BootstrapScreen />
  // Sign-in brokers for Desktop, the phone apps and plugins stay available; the Web workspace does not.
  if (webDeniedByE2ee && WEB_WORKSPACE_SCREENS.has(screen)) return <E2eeWebUnavailableScreen />
  if (screen === "app") return isAuthenticated ? <Demo /> : <LoginScreen />
  if (screen === "signed-out") return <SignedOutScreen />
  if (screen === "register") return <RegisterScreen />
  if (screen === "forgot-password") return <ForgotPasswordScreen />
  if (screen === "oauth-new-user") return <OAuthNewUserScreen />
  if (screen === "oauth-link-existing") return <OAuthLinkExistingScreen />
  if (screen === "tokens-anywhere-oauth") return <TokensAnywhereOAuthFlow />
  if (screen === "mobile-oauth") return <MobileOAuthFlow />
  if (screen === "desktop-oauth") return <DesktopOAuthFlow />
  if (screen === "plugin-oauth") return <PluginOAuthFlow />
  if (screen === "onboarding") return <PluginOnboardingPage />
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
      <AuthRouterContent />
    </AuthProvider>
  )
}

function AuthRouterContent() {
  const { screen, loading } = useAuth()
  return <><AuthRouterInner /><AnnouncementGate page={loading ? null : screen} /></>
}
