"use client"

import * as React from "react"
import { authApi } from "@/features/auth/api"
import {
  authResponseToSession,
  clearStoredSession,
  loadStoredSession,
  saveStoredSession,
} from "@/features/auth/session"
import type { AuthMe, OAuthFinalizePayload, StoredSession } from "@/features/auth/types"
import { useTranslations } from "next-intl"

export type AuthScreen =
  | "bootstrap"
  | "login"
  | "register"
  | "oauth-new-user"
  | "oauth-link-existing"
  | "app"

export type OAuthPending = {
  status: "authenticated" | "needs_password" | "needs_registration"
  pendingToken: string
  userId: string
}

type AuthState = {
  screen: AuthScreen
  needsBootstrap: boolean
  session: StoredSession | null
  me: AuthMe | null
  loading: boolean
  error: string | null
  isAuthenticated: boolean
  oauthEnabled: boolean
  oauthProviderLabel: string | null
  oauthPending: OAuthPending | null
  registrationOpen: boolean
  navigate: (screen: AuthScreen) => void
  login: (input: { userId: string; password: string }) => Promise<void>
  register: (input: { userId: string; password: string; setupToken?: string }) => Promise<void>
  startOAuth: () => Promise<void>
  finalizeOAuth: (input: { userId?: string; password?: string; setPassword?: boolean }) => Promise<void>
  cancelOAuth: () => void
  refreshMe: () => Promise<AuthMe | null>
  signOut: () => void
}

const AuthContext = React.createContext<AuthState | null>(null)

export function useAuth() {
  const ctx = React.useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}

function hashToScreen(hash: string): AuthScreen {
  // Exact matches for auth screens
  const exactMap: Record<string, AuthScreen> = {
    "#/login": "login",
    "#/register": "register",
    "#/oauth/new": "oauth-new-user",
    "#/oauth/link": "oauth-link-existing",
  }
  if (exactMap[hash]) return exactMap[hash]

  // Any app sub-route → app. Default bare hash "/" is also app.
  const path = hash.replace(/^#\/?/, "")
  const isAppRoute =
    path === "" ||
    path === "app" ||
    path.startsWith("session/") ||
    path.startsWith("settings") ||
    path === "team" ||
    path === "service" ||
    path.startsWith("device")

  if (isAppRoute) return "app"

  return "login"
}

function screenToHash(s: AuthScreen): string {
  const map: Record<AuthScreen, string> = {
    bootstrap: "#/bootstrap",
    login: "#/login",
    register: "#/register",
    "oauth-new-user": "#/oauth/new",
    "oauth-link-existing": "#/oauth/link",
    app: "#/",
  }
  return map[s] ?? "#/login"
}

function readOAuthPendingFromUrl(): OAuthPending | null {
  const params = new URLSearchParams(window.location.search)
  const pendingToken = params.get("oauth_pending")
  const status = params.get("oauth_status") as OAuthPending["status"] | null
  if (!pendingToken || !status) return null
  if (status !== "authenticated" && status !== "needs_password" && status !== "needs_registration") return null
  return {
    status,
    pendingToken,
    userId: params.get("oauth_user") ?? "",
  }
}

function readOAuthErrorFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("oauth_error")
}

function clearOAuthQueryParams() {
  const url = new URL(window.location.href)
  const hadOAuthParams =
    url.searchParams.has("oauth_pending") ||
    url.searchParams.has("oauth_status") ||
    url.searchParams.has("oauth_user") ||
    url.searchParams.has("oauth_error")
  if (!hadOAuthParams) return
  url.searchParams.delete("oauth_pending")
  url.searchParams.delete("oauth_status")
  url.searchParams.delete("oauth_user")
  url.searchParams.delete("oauth_error")
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`)
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("auth")
  // Start with "login" for safe SSR, then immediately correct from hash on mount.
  const [screen, setScreenState] = React.useState<AuthScreen>("login")
  const [session, setSession] = React.useState<StoredSession | null>(null)
  const [me, setMe] = React.useState<AuthMe | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [oauthEnabled, setOauthEnabled] = React.useState(false)
  const [oauthProviderLabel, setOauthProviderLabel] = React.useState<string | null>(null)
  const [oauthPending, setOauthPending] = React.useState<OAuthPending | null>(null)
  const [registrationOpen, setRegistrationOpen] = React.useState(false)

  // On mount: set screen from the current hash, then listen for changes.
  React.useEffect(() => {
    let cancelled = false
    const stored = loadStoredSession()
    const nextScreen = hashToScreen(window.location.hash)
    const initialOAuthPending = readOAuthPendingFromUrl()
    const initialOAuthError = readOAuthErrorFromUrl()
    clearOAuthQueryParams()

    async function boot() {
      if (initialOAuthError && !cancelled) {
        setError(initialOAuthError)
      }
      try {
        const config = await authApi.config()
        if (!cancelled) {
          setOauthEnabled(config.oauthEnabled)
          setOauthProviderLabel(config.oauthProviderLabel)
          setRegistrationOpen(config.registrationOpen)
        }
        if (config.needsBootstrap && !cancelled) {
          setScreenState("bootstrap")
          setLoading(false)
          return
        }
      } catch {
        // Server unreachable — fall through to normal auth flow.
      }
      if (initialOAuthPending) {
        setOauthPending(initialOAuthPending)
        if (!cancelled) {
          setScreenState(initialOAuthPending.status === "needs_registration" ? "oauth-new-user" : "oauth-link-existing")
          setLoading(false)
        }
        return
      }
      if (!stored) {
        if (!cancelled) {
          setScreenState(nextScreen === "app" ? "login" : nextScreen)
          setLoading(false)
        }
        return
      }
      setSession(stored)
      try {
        const currentUser = await authApi.me(stored.accessToken)
        if (cancelled) return
        setMe(currentUser)
        setScreenState(nextScreen === "login" || nextScreen === "register" ? "app" : nextScreen)
      } catch {
        clearStoredSession()
        if (cancelled) return
        setSession(null)
        setMe(null)
        setScreenState("login")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void boot()
    const handler = () => setScreenState(hashToScreen(window.location.hash))
    window.addEventListener("hashchange", handler)
    return () => {
      cancelled = true
      window.removeEventListener("hashchange", handler)
    }
  }, [])

  const navigate = React.useCallback((s: AuthScreen) => {
    window.location.hash = screenToHash(s)
    if (s === "login") setOauthPending(null)
    setScreenState(s)
  }, [])

  const finishAuth = React.useCallback(async (auth: Parameters<typeof authResponseToSession>[0]) => {
    const nextSession = authResponseToSession(auth)
    saveStoredSession(nextSession)
    setSession(nextSession)
    const currentUser = await authApi.me(nextSession.accessToken)
    setMe(currentUser)
    setError(null)
    setOauthPending(null)
    window.location.hash = "#/"
    setScreenState("app")
  }, [])

  React.useEffect(() => {
    if (!oauthPending || oauthPending.status !== "authenticated") return
    let cancelled = false
    const pendingToken = oauthPending.pendingToken
    async function finalizeAuthenticatedOAuth() {
      setLoading(true)
      setError(null)
      try {
        const result = await authApi.finalizeOAuth({ pendingToken })
        if (!cancelled) await finishAuth(result.auth)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("errors.oauth"))
          setOauthPending(null)
          setScreenState("login")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void finalizeAuthenticatedOAuth()
    return () => {
      cancelled = true
    }
  }, [finishAuth, oauthPending, t])

  const login = React.useCallback(
    async (input: { userId: string; password: string }) => {
      setLoading(true)
      setError(null)
      try {
        await finishAuth(await authApi.login(input))
      } catch (err) {
        setError(err instanceof Error ? err.message : t("errors.loginFailed"))
        throw err
      } finally {
        setLoading(false)
      }
    },
    [finishAuth, t],
  )

  const register = React.useCallback(
    async (input: { userId: string; password: string; setupToken?: string }) => {
      setLoading(true)
      setError(null)
      try {
        await finishAuth(await authApi.register(input))
      } catch (err) {
        setError(err instanceof Error ? err.message : t("errors.registerFailed"))
        throw err
      } finally {
        setLoading(false)
      }
    },
    [finishAuth, t],
  )

  const startOAuth = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await authApi.startOAuth(window.location.href)
      window.location.assign(result.authorizeUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.oauth"))
      setLoading(false)
      throw err
    }
  }, [t])

  const finalizeOAuth = React.useCallback(
    async (input: { userId?: string; password?: string; setPassword?: boolean }) => {
      if (!oauthPending) return
      setLoading(true)
      setError(null)
      try {
        const payload: OAuthFinalizePayload = {
          pendingToken: oauthPending.pendingToken,
          userId: input.userId?.trim().toLowerCase() || undefined,
          password: input.password || undefined,
          setPassword: Boolean(input.setPassword),
        }
        const result = await authApi.finalizeOAuth(payload)
        await finishAuth(result.auth)
      } catch (err) {
        setError(err instanceof Error ? err.message : t("errors.oauth"))
        throw err
      } finally {
        setLoading(false)
      }
    },
    [finishAuth, oauthPending, t],
  )

  const cancelOAuth = React.useCallback(() => {
    setOauthPending(null)
    setError(null)
    window.location.hash = "#/login"
    setScreenState("login")
  }, [])

  const refreshMe = React.useCallback(async () => {
    if (!session?.accessToken) {
      setMe(null)
      return null
    }
    const currentUser = await authApi.me(session.accessToken)
    setMe(currentUser)
    return currentUser
  }, [session?.accessToken])

  const signOut = React.useCallback(() => {
    clearStoredSession()
    setSession(null)
    setMe(null)
    setOauthPending(null)
    window.location.hash = "#/login"
    setScreenState("login")
  }, [])

  return (
    <AuthContext.Provider
      value={{
        screen,
        needsBootstrap: screen === "bootstrap",
        session,
        me,
        loading,
        error,
        isAuthenticated: Boolean(session),
        oauthEnabled,
        oauthProviderLabel,
        oauthPending,
        registrationOpen,
        navigate,

        login,
        register,
        startOAuth,
        finalizeOAuth,
        cancelOAuth,
        refreshMe,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
