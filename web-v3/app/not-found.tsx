"use client"

import { Compass } from "lucide-react"
import Link from "next/link"

import { useI18n } from "@/components/i18n-provider"
import { LanguageButton } from "@/components/language-menu"
import { ResultCard, SignInShell } from "@/components/sign-in/sign-in-shell"
import { Button } from "@/components/ui/button"
import { APP_CONFIG } from "@/lib/config"

export default function NotFoundPage() {
  const { t } = useI18n()

  return (
    <SignInShell
      brandName={APP_CONFIG.brandName}
      headerEnd={<LanguageButton />}
    >
      <ResultCard
        icon={Compass}
        title={t("notFound.title")}
        description={t("notFound.description")}
      >
        <Button render={<Link href="/" />} nativeButton={false}>
          {t("notFound.action")}
        </Button>
      </ResultCard>
    </SignInShell>
  )
}
