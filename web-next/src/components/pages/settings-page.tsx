"use client"

import { useState, useEffect } from "react"
import { ChevronLeft, User, Settings, Sun, RotateCw, QrCode } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/components/workspace-context"
import { LoadingState } from "@/components/loading-state"
import { useAuth } from "@/components/auth/auth-context"
import { authApi } from "@/features/auth/api"
import type { AuthMe } from "@/features/auth/types"
import { useTheme } from "next-themes"
import { useTranslations } from "next-intl"

type SettingsTab = "account" | "agent" | "appearance"
type AppearanceMode = "light" | "dark" | "auto"

const navItems: { id: SettingsTab; labelKey: "account" | "agent" | "appearance"; icon: typeof User }[] = [
  { id: "account", labelKey: "account", icon: User },
  { id: "agent", labelKey: "agent", icon: Settings },
  { id: "appearance", labelKey: "appearance", icon: Sun },
]

function AccountTab({ me }: { me: AuthMe }) {
  const t = useTranslations("pages.settings")
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card">
        <div className="px-6 py-5">
          <h2 className="text-base font-semibold">{t("account")}</h2>
        </div>
        <Separator />
        <div className="flex items-center gap-4 px-6 py-5">
          <Avatar className="size-16 rounded-full">
            {me.avatar && <AvatarImage src={me.avatar} alt={me.userId} />}
            <AvatarFallback className="rounded-full bg-primary text-primary-foreground text-xl">
              {me.userId.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div>
            <p className="text-base font-semibold">{me.userId}</p>
            <p className="text-sm text-muted-foreground capitalize">{me.role}</p>
          </div>
        </div>
        <Separator />
        <div className="divide-y divide-border">
          <div className="flex items-center px-6 py-4">
            <span className="w-36 shrink-0 text-sm text-muted-foreground">{t("userId")}</span>
            <span className="font-mono text-sm">{me.userId}</span>
          </div>
          <div className="flex items-center px-6 py-4">
            <span className="w-36 shrink-0 text-sm text-muted-foreground">{t("role")}</span>
            <span className="font-mono text-sm">{me.role}</span>
          </div>
          <div className="flex items-center px-6 py-4">
            <span className="w-36 shrink-0 text-sm text-muted-foreground">{t("accountStatus")}</span>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
                me.disabled
                  ? "bg-red-500/10 text-red-500"
                  : "bg-emerald-500/10 text-emerald-600",
              )}
            >
              <span className={cn("size-1.5 rounded-full", me.disabled ? "bg-red-500" : "bg-emerald-500")} />
              {me.disabled ? t("disabled") : t("active")}
            </span>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between px-6 py-5">
          <div>
            <h2 className="text-base font-semibold">{t("password")}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{t("passwordDescription")}</p>
          </div>
          <Button variant="destructive" size="sm">
            <RotateCw className="size-3.5" />
            {t("resetPassword")}
          </Button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card">
        <div className="px-6 py-5">
          <h2 className="text-base font-semibold">{t("mobileSignIn")}</h2>
        </div>
        <Separator />
        <div className="flex items-center justify-between px-6 py-5">
          <div>
            <p className="text-sm font-medium">{t("mobileSignIn")}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {t("mobileDescription")}
            </p>
          </div>
          <Button variant="outline" size="sm">
            <QrCode className="size-3.5" />
            {t("generateQr")}
          </Button>
        </div>
      </section>
    </div>
  )
}

function AgentTab() {
  const t = useTranslations("pages.settings")
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card">
        <div className="px-6 py-5">
          <h2 className="text-base font-semibold">{t("agent")}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t("agentDescription")}
          </p>
        </div>
        <Separator />
        <div className="divide-y divide-border">
          <div className="flex items-center justify-between px-6 py-4">
            <div>
              <p className="text-sm font-medium">{t("defaultModel")}</p>
              <p className="text-xs text-muted-foreground">{t("defaultModelDescription")}</p>
            </div>
            <span className="font-mono text-xs text-muted-foreground">GPT-5.5</span>
          </div>
          <div className="flex items-center justify-between px-6 py-4">
            <div>
              <p className="text-sm font-medium">{t("reasoningEffort")}</p>
              <p className="text-xs text-muted-foreground">{t("reasoningDescription")}</p>
            </div>
            <span className="font-mono text-xs text-muted-foreground">{t("medium")}</span>
          </div>
          <div className="flex items-center justify-between px-6 py-4">
            <div>
              <p className="text-sm font-medium">{t("askApproval")}</p>
              <p className="text-xs text-muted-foreground">{t("askApprovalDescription")}</p>
            </div>
            <span className="font-mono text-xs text-muted-foreground">{t("enabled")}</span>
          </div>
        </div>
      </section>
    </div>
  )
}

const themes: { id: AppearanceMode; labelKey: "light" | "dark" | "auto"; descKey: "lightDescription" | "darkDescription" | "autoDescription" }[] = [
  { id: "light", labelKey: "light", descKey: "lightDescription" },
  { id: "dark", labelKey: "dark", descKey: "darkDescription" },
  { id: "auto", labelKey: "auto", descKey: "autoDescription" },
]

function AppearanceTab() {
  const t = useTranslations("pages.settings")
  const { theme, setTheme } = useTheme()
  const selected: AppearanceMode = theme === "light" || theme === "dark" ? theme : "auto"

  const handleThemeChange = (nextTheme: AppearanceMode) => {
    setTheme(nextTheme === "auto" ? "system" : nextTheme)
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card">
        <div className="px-6 py-5">
          <h2 className="text-base font-semibold">{t("appearance")}</h2>
        </div>
        <Separator />
        <div className="grid grid-cols-3 gap-4 p-6">
          {themes.map((themeOption) => (
            <button
              key={themeOption.id}
              type="button"
              onClick={() => handleThemeChange(themeOption.id)}
              className={cn(
                "group relative rounded-xl border-2 p-3 text-left transition-all",
                selected === themeOption.id ? "border-primary" : "border-border hover:border-border/80",
              )}
            >
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-medium">{t(themeOption.labelKey)}</span>
                <span
                  className={cn(
                    "size-4 rounded-full border-2",
                    selected === themeOption.id ? "border-primary bg-primary" : "border-muted-foreground/30",
                  )}
                />
              </div>
              <div
                className={cn(
                  "h-24 rounded-lg overflow-hidden",
                  themeOption.id === "light" ? "bg-slate-100" : "bg-[#1a1a2e]",
                )}
              >
                <div className={cn("h-6 w-full", themeOption.id === "light" ? "bg-blue-500" : "bg-blue-600")} />
                <div className="flex h-[calc(100%-1.5rem)]">
                  <div className={cn("w-8 h-full", themeOption.id === "light" ? "bg-slate-200" : "bg-[#252540]")} />
                  <div className={cn("flex-1 p-1", themeOption.id === "light" ? "bg-white" : "bg-[#111111]")}>
                    <div className="flex gap-1 mb-1">
                      <div className="size-2 rounded-full bg-red-400" />
                      <div className="size-2 rounded-full bg-muted-foreground/40" />
                      <div className="size-2 rounded-full bg-green-400" />
                    </div>
                    <div className={cn("h-1 rounded w-3/4 mb-1", themeOption.id === "light" ? "bg-slate-200" : "bg-white/10")} />
                    <div className={cn("h-1 rounded w-1/2", themeOption.id === "light" ? "bg-slate-200" : "bg-white/10")} />
                  </div>
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{t(themeOption.descKey)}</p>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

export function SettingsPage() {
  const { navigate, settingsTab } = useWorkspace()
  const { session, me: authMe } = useAuth()
  const t = useTranslations("pages.settings")
  const tCommon = useTranslations("common")
  const [tab, setTab] = useState<SettingsTab>((settingsTab as SettingsTab) ?? "account")
  const [me, setMe] = useState<AuthMe | null>(authMe)
  const [loadingMe, setLoadingMe] = useState(!authMe)
  const [meError, setMeError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    if (authMe) {
      setMe(authMe)
      setLoadingMe(false)
    }

    if (!session?.accessToken) {
      setLoadingMe(false)
      return
    }

    setLoadingMe(true)
    setMeError(null)
    authApi
      .me(session.accessToken)
      .then((nextMe) => {
        if (!cancelled) setMe(nextMe)
      })
      .catch((err) => {
        if (!cancelled) setMeError(err instanceof Error ? err.message : t("loadFailed"))
      })
      .finally(() => {
        if (!cancelled) setLoadingMe(false)
      })

    return () => {
      cancelled = true
    }
  }, [authMe, session?.accessToken, t])

  // Sync tab with hash-driven settingsTab
  useEffect(() => {
    if (settingsTab && ["account", "agent", "appearance"].includes(settingsTab)) {
      setTab(settingsTab as SettingsTab)
    }
  }, [settingsTab])

  const handleTabChange = (newTab: SettingsTab) => {
    setTab(newTab)
    navigate("settings", newTab)
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="px-8 pt-8 pb-0">
        <button
          type="button"
          onClick={() => navigate("home")}
          className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          {tCommon("back")}
        </button>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("description")}
        </p>
      </div>

      <div className="flex flex-1 gap-8 overflow-hidden px-8 py-8">
        <nav className="w-52 shrink-0 space-y-0.5">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleTabChange(item.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                  tab === item.id
                    ? "bg-sidebar-accent text-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {t(item.labelKey)}
              </button>
            )
          })}
        </nav>

        <ScrollArea className="flex-1">
          {tab === "account" && (
            loadingMe ? (
              <LoadingState className="h-full" />
            ) : meError ? (
              <div className="flex h-full items-center justify-center text-sm text-destructive">{meError}</div>
            ) : me ? (
              <AccountTab me={me} />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("unavailable")}</div>
            )
          )}
          {tab === "agent" && <AgentTab />}
          {tab === "appearance" && <AppearanceTab />}
        </ScrollArea>
      </div>
    </div>
  )
}
