"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import { isApiError } from "@/lib/api/errors"

/** A runtime or workflow failure as reported: a stable code when known, plus the original message. */
export type RuntimeFailure = { code?: string; message?: string }

/** Keeps the stable code of an API or Connector failure so the UI can translate it. */
export function runtimeFailureOf(error: unknown): RuntimeFailure {
  if (isApiError(error)) return { code: error.code, message: error.detail || error.message }
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code
    return { code: typeof code === "string" ? code : undefined, message: error.message }
  }
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown }
    return { code: typeof value.code === "string" ? value.code : undefined, message: typeof value.message === "string" ? value.message : undefined }
  }
  return { message: typeof error === "string" ? error : undefined }
}

/**
 * Text for a failure in the UI language. Known codes use the `runtimeErrors`
 * entry; only unknown codes fall back to the server or Connector message.
 */
export function useRuntimeErrorText() {
  const t = useTranslations("runtimeErrors")
  // Stable per language, so callers can list it as a hook dependency.
  return React.useCallback((failure: RuntimeFailure | null | undefined, fallback?: string): string | undefined => {
    if (!failure) return fallback
    if (failure.code && t.has(failure.code)) return t(failure.code)
    return failure.message || fallback
  }, [t])
}

/**
 * Text for a caught error in the UI language: a known code uses its `runtimeErrors`
 * entry, otherwise the error's own message, then the fallback. The returned function
 * keeps one identity, so callbacks and effects can call it without depending on it.
 */
export function useErrorText() {
  const text = useRuntimeErrorText()
  const textRef = React.useRef(text)
  React.useEffect(() => {
    textRef.current = text
  }, [text])
  return React.useCallback((error: unknown, fallback?: string): string => (
    textRef.current(runtimeFailureOf(error), fallback) ?? String(error)
  ), [])
}
