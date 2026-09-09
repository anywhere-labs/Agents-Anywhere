"use client"

import { ArrowLeft } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"

const SECTION_IDS = [
  "local",
  "server",
  "agents",
  "external",
  "permissions",
  "retention",
  "contact",
] as const

/** Standalone policy page: reachable without signing in and linkable from outside. */
export function PrivacyPolicyScreen() {
  const t = useTranslations("privacy")

  const goBack = () => {
    if (typeof window === "undefined") return
    if (window.history.length > 1) window.history.back()
    else window.location.assign("/login")
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-3xl px-6 py-16 sm:py-24">
        <Button type="button" variant="ghost" size="sm" onClick={goBack}>
          <ArrowLeft data-icon="inline-start" />
          {t("back")}
        </Button>

        <h1 className="mt-8 text-pretty text-[clamp(2rem,4vw,3rem)] font-medium leading-[1.16] tracking-[-0.045em]">
          {t("title")}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">{t("updated")}</p>
        <p className="mt-10 text-pretty text-[17px] leading-[1.85] text-muted-foreground">
          {t("introduction")}
        </p>

        <div className="mt-14 flex flex-col gap-10">
          {SECTION_IDS.map((id) => (
            <section key={id} className="flex flex-col gap-3">
              <h2 className="text-lg font-medium tracking-[-0.02em]">
                {t(`sections.${id}.title`)}
              </h2>
              <p className="text-pretty text-[15px] leading-[1.85] text-muted-foreground">
                {t(`sections.${id}.body`)}
              </p>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
