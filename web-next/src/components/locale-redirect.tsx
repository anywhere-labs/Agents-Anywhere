"use client"

import * as React from "react"

import {
  detectBrowserLocale,
  localeFromPathname,
  readStoredLocale,
  writeStoredLocale,
  type AppLocale,
} from "@/i18n/client-locale"

type LocaleRedirectProps = {
  locale: AppLocale
}

export function LocaleRedirect({ locale }: LocaleRedirectProps) {
  React.useEffect(() => {
    const url = new URL(window.location.href)
    const pathLocale = localeFromPathname(url.pathname)
    if (pathLocale) {
      writeStoredLocale(pathLocale)
      const segments = url.pathname.split("/")
      segments.splice(1, 1)
      const pathname = segments.join("/") || "/"
      window.location.replace(`${pathname}${url.search}${url.hash}`)
      return
    }

    const nextLocale = readStoredLocale() ?? detectBrowserLocale()
    writeStoredLocale(nextLocale)
  }, [locale])

  return null
}
