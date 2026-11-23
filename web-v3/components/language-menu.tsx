"use client"

import { Languages } from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { LOCALES, LOCALE_LABELS, isLocale } from "@/lib/i18n"

export function LanguageItems() {
  const { locale, setLocale } = useI18n()
  return (
    <DropdownMenuRadioGroup
      value={locale}
      onValueChange={(value) => {
        if (isLocale(value)) setLocale(value)
      }}
    >
      {LOCALES.map((code) => (
        <DropdownMenuRadioItem key={code} value={code}>
          {LOCALE_LABELS[code]}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

export function LanguageButton({
  variant = "outline",
  compact = false,
  className,
}: {
  variant?: React.ComponentProps<typeof Button>["variant"]
  compact?: boolean
  className?: string
}) {
  const { t, locale } = useI18n()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant={variant} size="sm" className={className} />}
        aria-label={t("common.language")}
      >
        <Languages data-icon="inline-start" />
        <span className={compact ? "max-sm:hidden" : undefined}>
          {LOCALE_LABELS[locale]}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <LanguageItems />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
