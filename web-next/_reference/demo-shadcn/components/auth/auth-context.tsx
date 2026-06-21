"use client"

import * as React from "react"

export type AuthScreen =
  | "login"
  | "register"
  | "oauth-new-user"
  | "oauth-link-existing"
  | "oauth-link-verify"
  | "oauth-link-success"
  | "app"

type AuthState = {
  screen: AuthScreen
  oauthProvider: string
  oauthUsername: string
  navigate: (screen: AuthScreen) => void
  setOauthProvider: (p: string) => void
  setOauthUsername: (u: string) => void
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
  // Start with "login" for safe SSR, then immediately correct from hash on mount.
  const [screen, setScreenState] = React.useState<AuthScreen>("login")
  const [oauthProvider, setOauthProvider] = React.useState("GitLab")
  const [oauthUsername, setOauthUsername] = React.useState("testoauth")

  // On mount: set screen from the current hash, then listen for changes.
  React.useEffect(() => {
    setScreenState(hashToScreen(window.location.hash))
    const handler = () => setScreenState(hashToScreen(window.location.hash))
    window.addEventListener("hashchange", handler)
    return () => window.removeEventListener("hashchange", handler)
  }, [])

  const navigate = React.useCallback((s: AuthScreen) => {
    window.location.hash = screenToHash(s)
    setScreenState(s)
  }, [])

  const signOut = React.useCallback(() => {
    window.location.hash = "#/login"
    setScreenState("login")
  }, [])

  return (
    <AuthContext.Provider
      value={{ screen, oauthProvider, oauthUsername, navigate, setOauthProvider, setOauthUsername, signOut }}
    >
      {children}
    </AuthContext.Provider>
  )
}
