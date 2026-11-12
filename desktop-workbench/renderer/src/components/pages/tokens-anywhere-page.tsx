"use client"

import * as React from "react"
import { ExternalLink, Eye, EyeOff, Link2, RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useAuth } from "@/components/auth/auth-context"
import { DashboardSidebarToggle } from "@/components/dashboard-sidebar-toggle"
import { OnboardingShell } from "@/components/onboarding/reference/components/onboarding-shell"
import { SlideFrame } from "@/components/onboarding/reference/components/slide-frame"
import { Button as SlideButton } from "@/components/onboarding/reference/components/ui/button"
import { useErrorText, useModelConfigChanged } from "@/components/settings/model-configs-tab"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useWorkspace } from "@/components/workspace-context"
import { modelConfigApi } from "@/features/model-config/api"
import { openExternal } from "@/features/model-config/open-link"
import { useTokensLink } from "@/features/model-config/use-tokens-link"
import { useTokensAnywhereUrl } from "@/features/tokens-anywhere/address"
import { TokensAnywhereIcon, TokensAnywhereWordmark } from "@/features/tokens-anywhere/brand"
import { useTokensAnywhereSidebarVisibility } from "@/features/tokens-anywhere/sidebar-visibility"
import "@/components/onboarding/reference/styles/onboarding.css"

const CONSOLE_PATH = "/console/"
const EMBED_EXPIRED = "tokens:embed-expired"

/**
 * Tokens Anywhere in the workspace: with a linked account, its console embedded
 * here without signing in; otherwise, one click to authorize the link.
 */
export function TokensAnywherePage() {
  const t = useTranslations("dashboard.tokensAnywhere")
  const { modelConfig } = useWorkspace()
  const { session } = useAuth()
  const token = session?.accessToken ?? ""
  const changed = useModelConfigChanged()
  const errorText = useErrorText()
  const siteUrl = useTokensAnywhereUrl()
  const [sidebarVisible, setSidebarVisible] = useTokensAnywhereSidebarVisibility()
  const [reloads, setReloads] = React.useState(0)
  const tokens = modelConfig?.tokens
  const linked = tokens?.link?.status === "linked"
  const linking = useTokensLink({ token, linked, linkedAt: tokens?.link?.linkedAt, errorText, onChanged: changed })

  // Whether the account is linked comes with the model configuration; read it if nothing has yet.
  React.useEffect(() => {
    if (token && !modelConfig) changed()
  }, [changed, modelConfig, token])

  const toggleSidebarVisibility = () => {
    const nextVisible = !sidebarVisible
    setSidebarVisible(nextVisible)
    toast.success(t(nextVisible ? "shownToast" : "hiddenToast"))
  }
  const visibilityButton = (
    <Button type="button" variant="ghost" size="sm" onClick={toggleSidebarVisibility}>
      {sidebarVisible ? <EyeOff data-icon="inline-start" /> : <Eye data-icon="inline-start" />}
      {t(sidebarVisible ? "hideFromSidebar" : "showInSidebar")}
    </Button>
  )
  const consoleUrl = siteUrl ? tokensAnywherePage(siteUrl, CONSOLE_PATH) : null

  if (linked) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <DashboardSidebarToggle />
          <TokensAnywhereIcon className="size-4 shrink-0" />
          <TokensAnywhereWordmark label={t("title")} className="shrink-0 text-[20px]" />
          <div className="ml-auto flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setReloads((value) => value + 1)}>
              <RefreshCw data-icon="inline-start" />{t("reload")}
            </Button>
            {consoleUrl ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => void openExternal(consoleUrl)}>
                <ExternalLink data-icon="inline-start" />{t("openInBrowser")}
              </Button>
            ) : null}
            {visibilityButton}
          </div>
        </div>
        <EmbeddedConsole key={`${tokens?.link?.linkedAt}:${reloads}`} token={token} consoleUrl={consoleUrl} />
      </div>
    )
  }

  const reauthorize = Boolean(tokens?.link)
  const actions = !tokens ? <Spinner /> : !tokens.available ? (
    <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
  ) : (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-muted-foreground">{t(reauthorize ? "reauthHint" : "authorizeHint")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <SlideButton size="lg" disabled={linking.busy || !tokens.secretConfigured} onClick={() => void linking.link()}>
          {linking.authorizing ? <Spinner /> : <Link2 data-icon="inline-start" />}
          {t(linking.authorizing ? "waiting" : reauthorize ? "reauthorize" : "authorize")}
        </SlideButton>
        {consoleUrl ? (
          <Button type="button" variant="ghost" onClick={() => void openExternal(consoleUrl)}>
            <ExternalLink data-icon="inline-start" />{t("openInBrowser")}
          </Button>
        ) : null}
      </div>
      {!tokens.secretConfigured ? <p className="text-sm text-muted-foreground">{t("secretMissing")}</p> : null}
    </div>
  )

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <div className="absolute left-3 top-3.5 z-10">
        <DashboardSidebarToggle />
      </div>
      <div className="absolute right-3 top-3 z-10 rounded-md bg-background">{visibilityButton}</div>

      <div className="onboarding-viewport onboarding-viewport-embedded">
        <OnboardingShell wordmark={false}>
          <div className="slide-page">
            <SlideFrame id="tokens-anywhere" title={t("headline")} description={t("description")} actions={actions} />
          </div>
        </OnboardingShell>
      </div>
    </div>
  )
}

/**
 * The linked account's console. The Server trades the link for a single-use
 * address, so no Tokens Anywhere credential reaches the page; when the
 * console's own session ends, it asks for a new address to come back to.
 */
function EmbeddedConsole({ token, consoleUrl }: { token: string; consoleUrl: string | null }) {
  const t = useTranslations("dashboard.tokensAnywhere")
  const [frame, setFrame] = React.useState<{ url: string; origin: string } | null>(null)
  const [failed, setFailed] = React.useState(false)

  const load = React.useCallback(async (next?: string) => {
    setFailed(false)
    try {
      const ticket = await modelConfigApi.tokensEmbedTicket(token, next)
      setFrame({ url: ticket.url, origin: ticket.origin })
    } catch {
      setFailed(true)
    }
  }, [token])

  React.useEffect(() => {
    if (token) void load()
  }, [load, token])

  React.useEffect(() => {
    if (!frame) return
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== frame.origin) return
      const data: unknown = event.data
      if (!data || typeof data !== "object" || (data as { type?: unknown }).type !== EMBED_EXPIRED) return
      const next = (data as { next?: unknown }).next
      void load(typeof next === "string" && next.startsWith(CONSOLE_PATH) ? next : undefined)
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [frame, load])

  if (failed) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <span>{t("loadFailed")}</span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <RefreshCw data-icon="inline-start" />{t("retry")}
          </Button>
          {consoleUrl ? (
            <Button size="sm" variant="ghost" onClick={() => void openExternal(consoleUrl)}>
              <ExternalLink data-icon="inline-start" />{t("openInBrowser")}
            </Button>
          ) : null}
        </div>
      </div>
    )
  }
  if (!frame) return <div className="flex flex-1 items-center justify-center"><Spinner /></div>

  return (
    <iframe
      key={frame.url}
      src={frame.url}
      title={t("title")}
      className="min-h-0 w-full flex-1 border-0 bg-background"
      allow="clipboard-write"
    />
  )
}

function tokensAnywherePage(origin: string, path: string): string | null {
  try {
    return new URL(path, origin).href
  } catch {
    return null
  }
}
