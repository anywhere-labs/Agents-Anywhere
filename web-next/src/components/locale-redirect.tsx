"use client"

import * as React from "react"

import {
  detectBrowserLocale,
  hasManualStoredLocale,
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
      const storedLocale = readStoredLocale()
      if (hasManualStoredLocale() && storedLocale && storedLocale !== pathLocale) {
        const segments = url.pathname.split("/")
        segments[1] = storedLocale
        const pathname = segments.join("/") || "/"
        window.location.replace(`${pathname}${url.search}${url.hash}`)
        return
      }
      writeStoredLocale(pathLocale)
      return
    }

    const nextLocale = readStoredLocale() ?? detectBrowserLocale()
    writeStoredLocale(nextLocale)
    const pathname = url.pathname === "/" ? "" : url.pathname
    window.location.replace(`/${nextLocale}${pathname}${url.search}${url.hash}`)
  }, [locale])

  return null
}
