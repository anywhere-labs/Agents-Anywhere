"use client"

import * as React from "react"
import { authApi } from "@/features/auth/api"
import {
  authResponseToSession,
  clearStoredSession,
  loadStoredSession,
  saveStoredSession,
} from "@/features/auth/session"
import type { AuthMe, StoredSession } from "@/features/auth/types"
import { useTranslations } from "next-intl"

export type AuthScreen =
  | "bootstrap"
  | "login"
  | "register"
  | "oauth-new-user"
  | "oauth-link-existing"
  | "oauth-link-verify"
  | "oauth-link-success"
  | "app"

type AuthState = {
  screen: AuthScreen
  needsBootstrap: boolean
  session: StoredSession | null
  me: AuthMe | null
  loading: boolean
  error: string | null
  isAuthenticated: boolean
  oauthProvider: string
  oauthUsername: string
  navigate: (screen: AuthScreen) => void
  setOauthProvider: (p: string) => void
  setOauthUsername: (u: string) => void
  login: (input: { userId: string; password: string }) => Promise<void>
  register: (input: { userId: string; password: string; setupToken?: string }) => Promise<void>
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
    "oauth-link-verify": "#/oauth/link",
    "oauth-link-success": "#/oauth/link",
    app: "#/",
  }
  return map[s] ?? "#/login"
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("auth")
  // Start with "login" for safe SSR, then immediately correct from hash on mount.
  const [screen, setScreenState] = React.useState<AuthScreen>("login")
  const [session, setSession] = React.useState<StoredSession | null>(null)
  const [me, setMe] = React.useState<AuthMe | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [oauthProvider, setOauthProvider] = React.useState("GitLab")
  const [oauthUsername, setOauthUsername] = React.useState("testoauth")

  // On mount: set screen from the current hash, then listen for changes.
  React.useEffect(() => {
    let cancelled = false
    const stored = loadStoredSession()
    const nextScreen = hashToScreen(window.location.hash)

    async function boot() {
      try {
        const config = await authApi.config()
        if (config.needsBootstrap && !cancelled) {
          setScreenState("bootstrap")
          setLoading(false)
          return
        }
      } catch {
        // Server unreachable — fall through to normal auth flow.
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
    setScreenState(s)
  }, [])

  const finishAuth = React.useCallback(async (auth: Parameters<typeof authResponseToSession>[0]) => {
    const nextSession = authResponseToSession(auth)
    saveStoredSession(nextSession)
    setSession(nextSession)
    const currentUser = await authApi.me(nextSession.accessToken)
    setMe(currentUser)
    setError(null)
    window.location.hash = "#/"
    setScreenState("app")
  }, [])

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

  const signOut = React.useCallback(() => {
    clearStoredSession()
    setSession(null)
    setMe(null)
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
        oauthProvider,
        oauthUsername,
        navigate,
        setOauthProvider,
        setOauthUsername,
        login,
        register,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
