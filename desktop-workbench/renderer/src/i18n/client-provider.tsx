"use client"

import * as React from "react"
import { NextIntlClientProvider } from "next-intl"

import enMessages from "../../messages/en.json"
import zhCNMessages from "../../messages/zh-CN.json"
import {
  detectBrowserLocale,
  readStoredLocale,
  writeStoredLocale,
  type AppLocale,
} from "@/i18n/client-locale"
import { routing } from "@/i18n/routing"

const messagesByLocale = {
  en: enMessages,
  "zh-CN": zhCNMessages,
} satisfies Record<AppLocale, Record<string, unknown>>

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = React.useState<AppLocale>(routing.defaultLocale)

  React.useEffect(() => {
    const nextLocale = readStoredLocale() ?? detectBrowserLocale()
    writeStoredLocale(nextLocale)
    setLocale(nextLocale)
  }, [])

  React.useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  return (
    <NextIntlClientProvider
      locale={locale}
      messages={messagesByLocale[locale]}
      timeZone="Asia/Shanghai"
    >
      {children}
    </NextIntlClientProvider>
  )
}
