"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"

import { LoadingState } from "@/components/loading-state"
import { authApi } from "@/features/auth/api"
import { AuthProvider, useAuth } from "./auth-context"
import { BootstrapScreen } from "./bootstrap-screen"
import { LoginScreen } from "./login-screen"
import { OAuthLinkExistingScreen } from "./oauth-link-existing-screen"
import { OAuthNewUserScreen } from "./oauth-new-user-screen"
import { RegisterScreen } from "./register-screen"
import { SignedOutScreen } from "./signed-out-screen"

type MobileOAuthParams = {
  response_type: string
  client_id: string
  redirect_uri: string
  code_challenge: string
  code_challenge_method: string
  scope: string
  state?: string
}

export function MobileOAuthPage() {
  return (
    <AuthProvider>
      <MobileOAuthFlow />
    </AuthProvider>
  )
}

export function MobileOAuthFlow() {
  const params = useSearchParams()
  const { screen, loading, isAuthenticated, session } = useAuth()
  const [error, setError] = React.useState<string | null>(null)
  const redirectingRef = React.useRef(false)

  const oauthParams = React.useMemo(() => readMobileOAuthParams(params), [params])
  const accessToken = session?.accessToken ?? null

  React.useEffect(() => {
    if (loading || !isAuthenticated || !accessToken || !oauthParams || redirectingRef.current) return
    const token = accessToken
    const payload = oauthParams
    redirectingRef.current = true
    setError(null)
    async function authorize() {
      try {
        const result = await authApi.authorizeOAuth(token, payload)
        window.location.assign(result.redirectUrl)
      } catch (err) {
        redirectingRef.current = false
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    void authorize()
  }, [accessToken, isAuthenticated, loading, oauthParams])

  if (!oauthParams) {
    return <MobileOAuthStatus message="Invalid mobile login request." error />
  }
  if (error) {
    return <MobileOAuthStatus message={error} error />
  }
  if (loading || isAuthenticated) {
    return <LoadingState className="min-h-screen bg-background" label="Opening Agents Anywhere..." />
  }
  if (screen === "bootstrap") return <BootstrapScreen />
  if (screen === "register") return <RegisterScreen />
  if (screen === "signed-out") return <SignedOutScreen />
  if (screen === "oauth-new-user") return <OAuthNewUserScreen />
  if (screen === "oauth-link-existing") return <OAuthLinkExistingScreen />
  return <LoginScreen />
}

function readMobileOAuthParams(params: { get(name: string): string | null }): MobileOAuthParams | null {
  const responseType = params.get("response_type")
  const clientId = params.get("client_id")
  const redirectUri = params.get("redirect_uri")
  const codeChallenge = params.get("code_challenge")
  if (!responseType || !clientId || !redirectUri || !codeChallenge) return null
  return {
    response_type: responseType,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: params.get("code_challenge_method") || "S256",
    scope: params.get("scope") || "",
    state: params.get("state") || undefined,
  }
}

function MobileOAuthStatus({ message, error = false }: { message: string; error?: boolean }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-center">
      <p className={error ? "max-w-sm text-sm text-destructive" : "max-w-sm text-sm text-muted-foreground"}>
        {message}
      </p>
    </main>
  )
}
