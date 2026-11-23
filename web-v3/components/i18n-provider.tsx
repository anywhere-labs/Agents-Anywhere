"use client"

import { useCallback, useEffect, useSyncExternalStore } from "react"

import {
  DEFAULT_LOCALE,
  LANGUAGE_STORAGE_KEY,
  detectLocale,
  translate,
  type Locale,
  type MessageKey,
  type Vars,
} from "@/lib/i18n"

const listeners = new Set<() => void>()

function readStored(): string | null {
  try {
    return window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
  } catch {
    return null
  }
}

function getSnapshot(): Locale {
  return detectLocale(readStored(), navigator.languages ?? [navigator.language])
}

function getServerSnapshot(): Locale {
  return DEFAULT_LOCALE
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === LANGUAGE_STORAGE_KEY) listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

export function setLocale(locale: Locale) {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, locale)
  } catch {
    // Storage unavailable (private mode): choice lasts for this tab.
  }
  listeners.forEach((listener) => listener())
}

export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const t = useCallback(
    (key: MessageKey, vars?: Vars) => translate(locale, key, vars),
    [locale]
  )
  return { locale, t, setLocale }
}

/** Keeps `<html lang>` synchronized with the active locale. */
export function HtmlLang() {
  const { locale } = useI18n()
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  return null
}
