"use client"

import { ChevronDown, Globe2 } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { isAppLocale, writeStoredLocale, type AppLocale } from "@/i18n/client-locale"
import { cn } from "@/lib/utils"

const languages: { id: AppLocale; labelKey: "english" | "simplifiedChinese" }[] = [
  { id: "en", labelKey: "english" },
  { id: "zh-CN", labelKey: "simplifiedChinese" },
]

type LocaleSwitcherProps = {
  className?: string
  size?: "default" | "sm"
  variant?: "outline" | "ghost"
}

export function LocaleSwitcher({ className, size = "default", variant = "outline" }: LocaleSwitcherProps) {
  const locale = useLocale() as AppLocale
  const t = useTranslations("pages.settings")

  const handleLocaleChange = (value: string) => {
    if (!isAppLocale(value) || value === locale) return
    writeStoredLocale(value, { manual: true })

    const url = new URL(window.location.href)
    const segments = url.pathname.split("/")
    if (isAppLocale(segments[1])) {
      segments[1] = value
    } else {
      segments.splice(1, 0, value)
    }
    url.pathname = segments.join("/") || "/"
    window.location.assign(`${url.pathname}${url.search}${url.hash}`)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size={size}
          className={cn("justify-between", size === "sm" ? "min-w-32" : "min-w-40", className)}
        >
          <Globe2 data-icon="inline-start" />
          {t(languages.find((language) => language.id === locale)?.labelKey ?? "english")}
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuRadioGroup value={locale} onValueChange={handleLocaleChange}>
          {languages.map((language) => (
            <DropdownMenuRadioItem key={language.id} value={language.id}>
              {t(language.labelKey)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
