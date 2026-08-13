"use client"

import * as React from "react"
import Cropper, { type Area, type Point } from "react-easy-crop"
import {
  Camera,
  ChevronDown,
  ChevronLeft,
  RotateCw,
  Settings,
  Sun,
  Trash2,
  Upload,
  User,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { toast } from "sonner"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Spinner } from "@/components/ui/spinner"
import { MobileSignInPanel } from "@/components/pages/mobile-signin-panel"
import { DashboardSidebarToggle } from "@/components/dashboard-sidebar-toggle"
import { useAuth } from "@/components/auth/auth-context"
import { LocaleSwitcher } from "@/components/locale-switcher"
import { LoadingState } from "@/components/loading-state"
import { useWorkspace } from "@/components/workspace-context"
import { authApi } from "@/features/auth/api"
import type { AuthMe } from "@/features/auth/types"
import { cn } from "@/lib/utils"

type SettingsTab = "account" | "agent" | "appearance"
type AppearanceMode = "light" | "dark" | "auto"

const AVATAR_OUTPUT_SIZE = 256
const AVATAR_MAX_FILE_SIZE = 8 * 1024 * 1024

const navItems: { id: SettingsTab; labelKey: "account" | "agent" | "appearance"; icon: typeof User }[] = [
  { id: "account", labelKey: "account", icon: User },
  { id: "agent", labelKey: "agent", icon: Settings },
  { id: "appearance", labelKey: "appearance", icon: Sun },
]

function AccountTab({
  me,
  token,
  onMeChange,
}: {
  me: AuthMe
  token: string
  onMeChange: (me: AuthMe) => void
}) {
  const t = useTranslations("pages.settings")
  const [passwordOpen, setPasswordOpen] = React.useState(false)
  const [avatarOpen, setAvatarOpen] = React.useState(false)
  const [clearingAvatar, setClearingAvatar] = React.useState(false)

  const clearAvatar = async () => {
    if (!token || clearingAvatar) return
    setClearingAvatar(true)
    try {
      onMeChange(await authApi.clearAvatar(token))
    } finally {
      setClearingAvatar(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-border bg-card">
        <div className="px-6 py-5">
          <h2 className="text-base font-semibold">{t("account")}</h2>
        </div>
        <Separator />
        <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-5">
          <div className="flex min-w-0 items-center gap-4">
            <Avatar className="size-16 rounded-full">
              {me.avatar && <AvatarImage src={me.avatar} alt={me.userId} />}
              <AvatarFallback className="rounded-full bg-primary text-xl text-primary-foreground">
                {me.userId.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-base font-semibold">{me.userId}</p>
              <p className="text-sm capitalize text-muted-foreground">{me.role}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {me.avatar ? (
              <Button type="button" variant="outline" size="sm" onClick={clearAvatar} disabled={clearingAvatar}>
                {clearingAvatar ? <Spinner /> : <Trash2 data-icon="inline-start" />}
                {t("removeAvatar")}
              </Button>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={() => setAvatarOpen(true)}>
              <Camera data-icon="inline-start" />
              {t("changeAvatar")}
            </Button>
          </div>
        </div>
        <Separator />
        <div className="divide-y divide-border">
          <div className="flex items-center px-6 py-4">
            <span className="w-36 shrink-0 text-sm text-muted-foreground">{t("userId")}</span>
            <span className="code-mono text-sm">{me.userId}</span>
          </div>
          <div className="flex items-center px-6 py-4">
            <span className="w-36 shrink-0 text-sm text-muted-foreground">{t("role")}</span>
            <span className="code-mono text-sm">{me.role}</span>
          </div>
          <div className="flex items-center px-6 py-4">
            <span className="w-36 shrink-0 text-sm text-muted-foreground">{t("accountStatus")}</span>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
                me.disabled ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-600",
              )}
            >
              <span className={cn("size-1.5 rounded-full", me.disabled ? "bg-destructive" : "bg-emerald-500")} />
              {me.disabled ? t("disabled") : t("active")}
            </span>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between gap-4 px-6 py-5">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{t("password")}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{t("passwordDescription")}</p>
          </div>
          <Button type="button" variant="destructive" size="sm" onClick={() => setPasswordOpen(true)}>
            <RotateCw data-icon="inline-start" />
            {t("resetPassword")}
          </Button>
        </div>
      </section>

      <MobileSignInPanel token={token} userId={me.userId} />

      <ResetPasswordDialog open={passwordOpen} token={token} onOpenChange={setPasswordOpen} />
      <AvatarCropDialog
        open={avatarOpen}
        token={token}
        userId={me.userId}
        onMeChange={onMeChange}
        onOpenChange={setAvatarOpen}
      />
    </div>
  )
}

function ResetPasswordDialog({
  open,
  token,
  onOpenChange,
}: {
  open: boolean
  token: string
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("pages.settings")
  const [password, setPassword] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) {
      setPassword("")
      setConfirm("")
      setError(null)
      setSaving(false)
    }
  }, [open])

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving) return
    if (password.length < 8) {
      setError(t("passwordTooShort"))
      return
    }
    if (password !== confirm) {
      setError(t("passwordMismatch"))
      return
    }
    setSaving(true)
    setError(null)
    try {
      await authApi.changePassword(token, { newPassword: password })
      toast.success(t("passwordResetSaved"))
      setPassword("")
      setConfirm("")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("passwordResetFailed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("resetPassword")}</DialogTitle>
          <DialogDescription>{t("resetPasswordDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <FieldGroup>
            <Field data-invalid={Boolean(error && password.length < 8)}>
              <FieldLabel htmlFor="settings-new-password">{t("newPassword")}</FieldLabel>
              <Input
                id="settings-new-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                aria-invalid={Boolean(error && password.length < 8)}
              />
              <FieldDescription>{t("newPasswordDescription")}</FieldDescription>
            </Field>
            <Field data-invalid={Boolean(error && confirm.length > 0 && password !== confirm)}>
              <FieldLabel htmlFor="settings-confirm-password">{t("confirmPassword")}</FieldLabel>
              <Input
                id="settings-confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.currentTarget.value)}
                aria-invalid={Boolean(error && confirm.length > 0 && password !== confirm)}
              />
            </Field>
          </FieldGroup>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Spinner /> : <RotateCw data-icon="inline-start" />}
              {t("savePassword")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AvatarCropDialog({
  open,
  token,
  userId,
  onMeChange,
  onOpenChange,
}: {
  open: boolean
  token: string
  userId: string
  onMeChange: (me: AuthMe) => void
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("pages.settings")
  const [source, setSource] = React.useState<string | null>(null)
  const [crop, setCrop] = React.useState<Point>({ x: 0, y: 0 })
  const [zoom, setZoom] = React.useState(1)
  const [croppedAreaPixels, setCroppedAreaPixels] = React.useState<Area | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    if (!open) {
      if (source) URL.revokeObjectURL(source)
      setSource(null)
      setCrop({ x: 0, y: 0 })
      setZoom(1)
      setCroppedAreaPixels(null)
      setSaving(false)
      setError(null)
    }
  }, [open, source])

  const selectFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ""
    if (!file) return
    if (!file.type.startsWith("image/")) {
      setError(t("avatarInvalidType"))
      return
    }
    if (file.size > AVATAR_MAX_FILE_SIZE) {
      setError(t("avatarTooLarge"))
      return
    }
    setError(null)
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setCroppedAreaPixels(null)
    setSource((current) => {
      if (current) URL.revokeObjectURL(current)
      return URL.createObjectURL(file)
    })
  }

  const saveAvatar = async () => {
    if (!source || !croppedAreaPixels || saving) return
    setSaving(true)
    setError(null)
    try {
      const avatar = await cropImageToDataUrl(source, croppedAreaPixels)
      onMeChange(await authApi.updateAvatar(token, avatar))
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("avatarUploadFailed"))
    } finally {
      setSaving(false)
    }
  }

  const clearSelectedImage = () => {
    setSource((current) => {
      if (current) URL.revokeObjectURL(current)
      return null
    })
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setCroppedAreaPixels(null)
    setError(null)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("changeAvatar")}</DialogTitle>
          <DialogDescription>{t("avatarDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          <Input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept="image/*"
            onChange={selectFile}
            tabIndex={-1}
          />
          <div className="relative mx-auto size-64 overflow-hidden rounded-2xl border border-border bg-muted">
            {source ? (
              <Cropper
                image={source}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="round"
                cropSize={{ width: AVATAR_OUTPUT_SIZE, height: AVATAR_OUTPUT_SIZE }}
                showGrid={false}
                restrictPosition
                objectFit="cover"
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={(_croppedArea, nextAreaPixels) => setCroppedAreaPixels(nextAreaPixels)}
                mediaProps={{ alt: t("avatarPreviewAlt", { userId }) }}
                style={{
                  cropAreaStyle: {
                    border: "2px solid rgba(255, 255, 255, 0.95)",
                    borderRadius: "9999px",
                    boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.35), 0 0 0 9999px rgba(0, 0, 0, 0.48)",
                  },
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex size-full flex-col items-center justify-center gap-3 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Camera className="size-8" />
                <span className="text-sm font-medium">{t("avatarEmpty")}</span>
                <span className="text-xs">{t("avatarClickHint")}</span>
              </button>
            )}
          </div>
          <FieldGroup>
            <Field data-disabled={!source}>
              <FieldLabel>{t("avatarZoom")}</FieldLabel>
              <Slider
                value={[zoom]}
                min={1}
                max={3}
                step={0.01}
                disabled={!source}
                onValueChange={(value: number[]) => setZoom(value[0] ?? 1)}
              />
            </Field>
          </FieldGroup>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={clearSelectedImage} disabled={!source || saving}>
            {t("clearImage")}
          </Button>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button type="button" onClick={saveAvatar} disabled={!source || !croppedAreaPixels || saving}>
            {saving ? <Spinner /> : <Upload data-icon="inline-start" />}
            {t("uploadAvatar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AgentTab({ token: _token }: { token: string }) {
  const t = useTranslations("pages.settings")

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-border bg-card">
        <div className="px-6 py-5">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{t("modelCatalog")}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Runtime catalogs are now provided by the connected local runtime through the connector.
              Model and permission selections are managed in the New Session composer and session
              snapshot, not as server-side user overrides.
            </p>
          </div>
        </div>
        <Separator />
        <div className="px-6 py-6 text-sm text-muted-foreground">
          Server-side static model lists and per-user model overrides have been removed.
        </div>
      </section>
    </div>
  )
}

const themes: { id: AppearanceMode; labelKey: string; descKey: string }[] = [
  { id: "light", labelKey: "light", descKey: "lightDescription" },
  { id: "dark", labelKey: "dark", descKey: "darkDescription" },
  { id: "auto", labelKey: "auto", descKey: "autoDescription" },
]

function AppearanceTab() {
  const t = useTranslations("pages.settings")
  const { theme, setTheme } = useTheme()
  const selected: AppearanceMode = theme === "light" || theme === "dark" ? theme : "auto"

  const handleThemeChange = (value: string) => {
    const nextTheme = value as AppearanceMode
    setTheme(nextTheme === "auto" ? "system" : nextTheme)
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-border bg-card">
        <div className="px-6 py-5">
          <h2 className="text-base font-semibold">{t("appearance")}</h2>
        </div>
        <Separator />
        <RadioGroup value={selected} onValueChange={handleThemeChange} className="p-2">
          {themes.map((themeOption) => (
            <FieldLabel
              key={themeOption.id}
              htmlFor={`theme-${themeOption.id}`}
              className={cn(
                "flex w-full cursor-pointer flex-row items-center gap-3 rounded-lg px-4 py-3 transition-colors hover:bg-accent/50",
                selected === themeOption.id && "bg-accent",
              )}
            >
              <RadioGroupItem id={`theme-${themeOption.id}`} value={themeOption.id} />
              <FieldContent>
                <span className="text-sm font-medium">{t(themeOption.labelKey)}</span>
                <span className="text-xs text-muted-foreground">{t(themeOption.descKey)}</span>
              </FieldContent>
            </FieldLabel>
          ))}
        </RadioGroup>
      </section>

      <section className="rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between gap-4 px-6 py-5">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{t("language")}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{t("languageDescription")}</p>
          </div>
          <LocaleSwitcher />
        </div>
      </section>
    </div>
  )
}

export function SettingsPage() {
  const { navigate, settingsTab } = useWorkspace()
  const { session, me: authMe, refreshMe } = useAuth()
  const t = useTranslations("pages.settings")
  const tCommon = useTranslations("common")
  const [tab, setTab] = React.useState<SettingsTab>((settingsTab as SettingsTab) ?? "account")
  const [me, setMe] = React.useState<AuthMe | null>(authMe)
  const [loadingMe, setLoadingMe] = React.useState(!authMe)
  const [meError, setMeError] = React.useState<string | null>(null)

  React.useEffect(() => {
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

  React.useEffect(() => {
    if (settingsTab && ["account", "agent", "appearance"].includes(settingsTab)) {
      setTab(settingsTab as SettingsTab)
    }
  }, [settingsTab])

  const handleTabChange = (newTab: SettingsTab) => {
    setTab(newTab)
    navigate("settings", newTab)
  }

  const handleMeChange = async (nextMe: AuthMe) => {
    setMe(nextMe)
    try {
      const refreshed = await refreshMe()
      if (refreshed) setMe(refreshed)
    } catch {
      // Keep the optimistic user returned by the mutation.
    }
  }

  const activeNavItem = navItems.find((item) => item.id === tab) ?? navItems[0]!
  const ActiveNavIcon = activeNavItem.icon

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="px-5 pb-0 pt-5 sm:px-8 sm:pt-8">
        <div className="mb-6 -ml-2 flex items-center gap-1">
          <DashboardSidebarToggle />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => navigate("home")}
            className="gap-1.5 text-muted-foreground"
          >
            <ChevronLeft className="size-4" />
            {tCommon("back")}
          </Button>
        </div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
        <SettingsCategoryDrawer
          tab={tab}
          activeIcon={ActiveNavIcon}
          activeLabel={t(activeNavItem.labelKey)}
          onTabChange={handleTabChange}
        />
      </div>

      <div className="flex min-h-0 flex-1 gap-8 overflow-hidden px-5 py-5 sm:px-8 sm:py-8">
        <nav className="hidden w-52 shrink-0 flex-col gap-0.5 lg:flex">
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

        <ScrollArea className="h-full min-h-0 min-w-0 flex-1" viewportProps={{ className: "pb-8" }}>
          {tab === "account" && (
            loadingMe ? (
              <LoadingState className="h-full" />
            ) : meError ? (
              <div className="flex h-full items-center justify-center text-sm text-destructive">{meError}</div>
            ) : me ? (
              <AccountTab me={me} token={session?.accessToken ?? ""} onMeChange={handleMeChange} />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {t("unavailable")}
              </div>
            )
          )}
          {tab === "agent" && <AgentTab token={session?.accessToken ?? ""} />}
          {tab === "appearance" && <AppearanceTab />}
        </ScrollArea>
      </div>
    </div>
  )
}

function SettingsCategoryDrawer({
  tab,
  activeIcon: ActiveIcon,
  activeLabel,
  onTabChange,
}: {
  tab: SettingsTab
  activeIcon: typeof User
  activeLabel: string
  onTabChange: (tab: SettingsTab) => void
}) {
  const t = useTranslations("pages.settings")
  const [open, setOpen] = React.useState(false)

  return (
    <Drawer open={open} onOpenChange={setOpen} direction="bottom">
      <DrawerTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="mt-4 gap-2 lg:hidden">
          <ActiveIcon className="size-4" />
          {activeLabel}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t("title")}</DrawerTitle>
        </DrawerHeader>
        <div className="flex flex-col gap-1 px-4 pb-4">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onTabChange(item.id)
                  setOpen(false)
                }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm transition-colors",
                  tab === item.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span className="font-medium">{t(item.labelKey)}</span>
              </button>
            )
          })}
        </div>
      </DrawerContent>
    </Drawer>
  )
}

async function cropImageToDataUrl(source: string, crop: Area): Promise<string> {
  const image = await loadImage(source)
  const canvas = document.createElement("canvas")
  canvas.width = AVATAR_OUTPUT_SIZE
  canvas.height = AVATAR_OUTPUT_SIZE
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Canvas is unavailable.")

  context.clearRect(0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE)
  context.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    AVATAR_OUTPUT_SIZE,
    AVATAR_OUTPUT_SIZE,
  )
  return canvas.toDataURL("image/webp", 0.88)
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.addEventListener("load", () => resolve(image), { once: true })
    image.addEventListener("error", () => reject(new Error("Image failed to load.")), { once: true })
    image.src = source
  })
}
