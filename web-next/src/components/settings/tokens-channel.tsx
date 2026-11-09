"use client"

import * as React from "react"
import { Link2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { SettingsSection } from "@/components/settings/settings-section"
import { TokensAccount } from "@/components/settings/tokens-account"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { ModelConfigOverview } from "@/features/dashboard/types"
import { modelConfigApi } from "@/features/model-config/api"
import { useTokensLink } from "@/features/model-config/use-tokens-link"

/** The Anywhere channel: link an account first, then its account, models and connection. */
export function TokensChannel({ token, overview, currentAction, signOut, connection, runtimes, errorText, onChanged }: {
  token: string
  overview: ModelConfigOverview
  /** Offered when Anywhere is not the default channel. */
  currentAction: React.ReactNode
  /** Leaves the linked account, moving its runtimes off it first. */
  signOut: React.ReactNode
  /** How runtimes reach the account: its address, key and their actions. */
  connection: React.ReactNode
  runtimes: React.ReactNode
  errorText: (error: unknown) => string
  onChanged: () => void
}) {
  const t = useTranslations("pages.settings.modelConfigs")
  const [busy, setBusy] = React.useState(false)
  const tokens = overview.tokens
  const linked = tokens?.link?.status === "linked"
  const profile = overview.profiles.find((item) => item.source === "tokens" && item.state === "active")
  const { link, busy: linking, authorizing } = useTokensLink({
    token, linked, linkedAt: tokens?.link?.linkedAt, errorText, onChanged,
  })

  if (!tokens?.available) return null

  const sync = async () => {
    setBusy(true)
    try {
      await modelConfigApi.syncTokens(token)
      toast.success(t("synced"))
      onChanged()
    } catch (error) { toast.error(errorText(error)) }
    finally { setBusy(false) }
  }

  if (!linked) {
    return (
      <SettingsSection variant="plain" title={t("channels.anywhere")} description={t("channel.description")}>
        <div className="flex flex-col items-start gap-3">
          {tokens.link ? <p className="text-sm text-muted-foreground">{t("tokensReauth")}</p> : null}
          <Button disabled={busy || linking || !tokens.secretConfigured} onClick={() => void link()}>
            {authorizing ? <Spinner /> : <Link2 data-icon="inline-start" />}
            {t(authorizing ? "channel.waiting" : tokens.link ? "relink" : "channel.link")}
          </Button>
          {/* A lapsed link keeps the connection runtimes still use. */}
          {connection ? <div className="w-full">{connection}</div> : null}
        </div>
      </SettingsSection>
    )
  }

  return (
    <TokensAccount key={tokens.link?.linkedAt} token={token} profile={profile}
      fallbackAccount={tokens.link?.account} syncing={busy}
      onSync={() => void sync()} onChanged={onChanged} errorText={errorText}
      action={(
        <>
          {currentAction}
          {signOut}
        </>
      )}
      connection={connection}
      runtimes={runtimes}
    />
  )
}
