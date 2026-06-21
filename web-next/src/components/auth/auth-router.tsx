"use client"

import { AuthProvider, useAuth } from "./auth-context"
import { LoginScreen } from "./login-screen"
import { RegisterScreen } from "./register-screen"
import { OAuthNewUserScreen } from "./oauth-new-user-screen"
import { OAuthLinkExistingScreen } from "./oauth-link-existing-screen"
import { Demo } from "@/components/demo"
import { LoadingState } from "@/components/loading-state"

function AuthRouterInner() {
  const { screen, loading, isAuthenticated } = useAuth()

  if (loading) {
    return (
      <LoadingState className="min-h-screen bg-background" />
    )
  }
  if (screen === "app") return isAuthenticated ? <Demo /> : <LoginScreen />
  if (screen === "register") return <RegisterScreen />
  if (screen === "oauth-new-user") return <OAuthNewUserScreen />
  if (screen === "oauth-link-existing") return <OAuthLinkExistingScreen />
  return <LoginScreen />
}

export function AuthRouter() {
  return (
    <AuthProvider>
      <AuthRouterInner />
    </AuthProvider>
  )
}
