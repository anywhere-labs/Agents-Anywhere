import { routing } from "@/i18n/routing"

export const LOCALE_STORAGE_KEY = "agents-anywhere.locale"

export type AppLocale = (typeof routing.locales)[number]

export function isAppLocale(value: string | undefined): value is AppLocale {
  return routing.locales.includes(value as AppLocale)
}

export function localeFromPathname(pathname: string): AppLocale | null {
  const firstSegment = pathname.split("/")[1]
  return isAppLocale(firstSegment) ? firstSegment : null
}

export function readStoredLocale(): AppLocale | null {
  try {
    const value = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    if (!value || !isAppLocale(value)) return null
    return value
  } catch {
    return null
  }
}

export function writeStoredLocale(locale: AppLocale) {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // localStorage can be unavailable in private contexts. Locale routing still works.
  }
}

export function detectBrowserLocale(): AppLocale {
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    const normalized = language.toLowerCase()
    if (normalized === "zh-cn" || normalized.startsWith("zh-hans") || normalized === "zh") {
      return "zh-CN"
    }
    if (normalized.startsWith("en")) {
      return "en"
    }
  }
  return routing.defaultLocale
}
