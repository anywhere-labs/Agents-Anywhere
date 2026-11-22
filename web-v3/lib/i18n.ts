import { APP_CONFIG } from "./config"
import { en } from "./locales/en"
import { zhCN } from "./locales/zh-CN"

export const LOCALES = ["en", "zh-CN"] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = APP_CONFIG.defaultLocale
export const LANGUAGE_STORAGE_KEY = "anywhere-ui.locale"

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
}

export type MessageKey = keyof typeof en
export type Messages = Record<MessageKey, string>
export type Vars = Record<string, string | number>

export const messages: Record<Locale, Messages> = {
  en,
  "zh-CN": zhCN,
}

export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "zh-CN"
}

export function detectLocale(
  stored: string | null | undefined,
  browserLanguages: readonly string[] | undefined
): Locale {
  if (isLocale(stored)) return stored
  for (const tag of browserLanguages ?? []) {
    if (tag.toLowerCase().startsWith("zh")) return "zh-CN"
    if (tag.toLowerCase().startsWith("en")) return "en"
  }
  return DEFAULT_LOCALE
}

export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  const template = messages[locale][key] ?? messages.en[key]
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  )
}

export function intlLocale(locale: Locale): string {
  return locale === "zh-CN" ? "zh-CN" : "en-US"
}
