import { APP_CONFIG } from "./config"
import { en } from "./locales/en"
import { enDrive } from "./locales/en-drive"
import { zhCN } from "./locales/zh-CN"
import { zhCNDrive } from "./locales/zh-CN-drive"

export const LOCALES = ["en", "zh-CN"] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = APP_CONFIG.defaultLocale
export const LANGUAGE_STORAGE_KEY = "anywhere-ui.locale"

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
}

/** The strings of `locales/en.ts`; `locales/zh-CN.ts` has exactly these keys. */
export type Messages = Record<keyof typeof en, string>
export type Vars = Record<string, string | number>

// Page modules merged on top of en.ts / zh-CN.ts (each pair keeps identical keys).
const enMessages = { ...en, ...enDrive }

export type MessageKey = keyof typeof enMessages

export const messages: Record<Locale, Record<MessageKey, string>> = {
  en: enMessages,
  "zh-CN": { ...zhCN, ...zhCNDrive },
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
