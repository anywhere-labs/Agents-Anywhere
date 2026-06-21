"use client"

import { useState, useEffect } from "react"
import { ChevronLeft, User, Settings, Sun, RotateCw, QrCode } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/components/workspace-context"
import { getMe, type AuthMe } from "@/lib/api"

const MOCK_TOKEN = "mock-token"

type SettingsTab = "account" | "agent" | "appearance"
type AppearanceMode = "light" | "dark" | "auto"

const navItems: { id: SettingsTab; label: string; icon: typeof User }[] = [
  { id: "account", label: "Account", icon: User },
  { id: "agent", label: "Agent settings", icon: Settings },
  { id: "appearance", label: "Appearance", icon: Sun },
]

function AccountTab({ me }: { me: AuthMe }) {
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card">
        <div className="px-6 py-5">
          <h2 className="text-base font-semibold">Account</h2>
        </div>
        <Separator />
        <div className="flex items-center gap-4 px-6 py-5">
          <Avatar className="size-16 rounded-xl">
            {me.avatar && <AvatarImage src={me.avatar} alt={me.userId} />}
            <AvatarFallback className="rounded-xl bg-primary text-primary-foreground text-xl">
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
            <span className="w-36 shrink-0 text-sm text-muted-foreground">User ID</span>
            <span className="font-mono text-sm">{me.userId}</span>
          </div>
          <div className="flex items-center px-6 py-4">
            <span className="w-36 shrink-0 text-sm text-muted-foreground">Role</span>
            <span className="font-mono text-sm">{me.role}</span>
          </div>
          <div className="flex items-center px-6 py-4">
            <span className="w-36 shrink-0 text-sm text-muted-foreground">Account status</span>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
                me.disabled
                  ? "bg-red-500/10 text-red-500"
                  : "bg-emerald-500/10 text-emerald-600",
              )}
            >
              <span className={cn("size-1.5 rounded-full", me.disabled ? "bg-red-500" : "bg-emerald-500")} />
              {me.disabled ? "Disabled" : "Active"}
            </span>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between px-6 py-5">
          <div>
            <h2 className="text-base font-semibold">Password</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Reset the password used to sign in.</p>
          </div>
          <Button variant="destructive" size="sm">
            <RotateCw className="size-3.5" />
            Reset password
          </Button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card">
        <div className="px-6 py-5">
          <h2 className="text-base font-semibold">Mobile sign-in</h2>
        </div>
        <Separator />
        <div className="flex items-center justify-between px-6 py-5">
          <div>
            <p className="text-sm font-medium">Mobile sign-in</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Sign in to the mobile client by scanning a short-lived QR code.
            </p>
          </div>
          <Button variant="outline" size="sm">
            <QrCode className="size-3.5" />
            Generate QR
          </Button>
        </div>
      </section>
    </div>
  )
}

function AgentTab() {
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card">
        <div className="px-6 py-5">
          <h2 className="text-base font-semibold">Agent settings</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Configure default behavior for agents running on your devices.
          </p>
        </div>
        <Separator />
        <div className="divide-y divide-border">
          <div className="flex items-center justify-between px-6 py-4">
            <div>
              <p className="text-sm font-medium">Default model</p>
              <p className="text-xs text-muted-foreground">Model used when starting a new session.</p>
            </div>
            <span className="font-mono text-xs text-muted-foreground">GPT-5.5</span>
          </div>
          <div className="flex items-center justify-between px-6 py-4">
            <div>
              <p className="text-sm font-medium">Reasoning effort</p>
              <p className="text-xs text-muted-foreground">Default reasoning level for new sessions.</p>
            </div>
            <span className="font-mono text-xs text-muted-foreground">Medium</span>
          </div>
          <div className="flex items-center justify-between px-6 py-4">
            <div>
              <p className="text-sm font-medium">Ask for approval</p>
              <p className="text-xs text-muted-foreground">Prompt before the agent executes commands.</p>
            </div>
            <span className="font-mono text-xs text-muted-foreground">Enabled</span>
          </div>
        </div>
      </section>
    </div>
  )
}

const themes: { id: AppearanceMode; label: string; desc: string }[] = [
  { id: "light", label: "Light", desc: "Bright interface" },
  { id: "dark", label: "Dark", desc: "Dim interface" },
  { id: "auto", label: "Auto", desc: "Follow system" },
]

function AppearanceTab() {
  const [selected, setSelected] = useState<AppearanceMode>("auto")

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card">
        <div className="px-6 py-5">
          <h2 className="text-base font-semibold">Appearance</h2>
        </div>
        <Separator />
        <div className="grid grid-cols-3 gap-4 p-6">
          {themes.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSelected(t.id)}
              className={cn(
                "group relative rounded-xl border-2 p-3 text-left transition-all",
                selected === t.id ? "border-primary" : "border-border hover:border-border/80",
              )}
            >
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-medium">{t.label}</span>
                <span
                  className={cn(
                    "size-4 rounded-full border-2",
                    selected === t.id
                      ? t.id === "auto"
                        ? "border-amber-400 bg-amber-400"
                        : "border-primary bg-primary"
                      : "border-muted-foreground/30",
                  )}
                />
              </div>
              <div
                className={cn(
                  "h-24 rounded-lg overflow-hidden",
                  t.id === "light" ? "bg-slate-100" : "bg-[#1a1a2e]",
                )}
              >
                <div className={cn("h-6 w-full", t.id === "light" ? "bg-blue-500" : "bg-blue-600")} />
                <div className="flex h-[calc(100%-1.5rem)]">
                  <div className={cn("w-8 h-full", t.id === "light" ? "bg-slate-200" : "bg-[#252540]")} />
                  <div className={cn("flex-1 p-1", t.id === "light" ? "bg-white" : "bg-[#111111]")}>
                    <div className="flex gap-1 mb-1">
                      <div className="size-2 rounded-full bg-red-400" />
                      <div className="size-2 rounded-full bg-yellow-400" />
                      <div className="size-2 rounded-full bg-green-400" />
                    </div>
                    <div className={cn("h-1 rounded w-3/4 mb-1", t.id === "light" ? "bg-slate-200" : "bg-white/10")} />
                    <div className={cn("h-1 rounded w-1/2", t.id === "light" ? "bg-slate-200" : "bg-white/10")} />
                  </div>
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{t.desc}</p>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

export function SettingsPage() {
  const { navigate, settingsTab } = useWorkspace()
  const [tab, setTab] = useState<SettingsTab>((settingsTab as SettingsTab) ?? "account")
  const [me, setMe] = useState<AuthMe | null>(null)

  useEffect(() => {
    getMe(MOCK_TOKEN).then(setMe)
  }, [])

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
          Back
        </button>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Account access and preferences for this browser.
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
                {item.label}
              </button>
            )
          })}
        </nav>

        <div className="flex-1 overflow-y-auto">
          {tab === "account" && (me ? <AccountTab me={me} /> : <div className="text-sm text-muted-foreground">Loading...</div>)}
          {tab === "agent" && <AgentTab />}
          {tab === "appearance" && <AppearanceTab />}
        </div>
      </div>
    </div>
  )
}
