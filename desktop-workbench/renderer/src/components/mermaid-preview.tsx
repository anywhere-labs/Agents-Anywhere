"use client"

import * as React from "react"
import { useTheme } from "next-themes"
import { useTranslations } from "next-intl"
import { renderMermaid } from "@/lib/mermaid-render"

export function MermaidPreview({ code, children }: { code: string; children: React.ReactNode }) {
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === "dark"
  const t = useTranslations("dashboard.session")
  const [result, setResult] = React.useState<{ code: string; dark: boolean; src: string } | null>(null)

  const [failedCode, setFailedCode] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    // Wait briefly for streaming fragments to settle before parsing a diagram.
    const timer = setTimeout(() => {
      void renderMermaid(code, dark).then(src => {
        if (!cancelled) {
          setResult({ code, dark, src })
          setFailedCode(null)
        }
      }).catch(() => {
        if (!cancelled) setFailedCode(code)
      })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [code, dark])

  // Keep the last valid preview visible while the next streaming fragment renders.
  if (!result) return <>{children}</>

  return (
    <>
      <div className="max-h-[36rem] max-w-full overflow-auto p-3" tabIndex={0} role="region" aria-label={t("mermaidDiagram")}>
        {/* Generated SVG data URL; no image optimization or remote service needed. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={result.src} alt={t("mermaidDiagram")} className="mx-auto max-w-none" />
      </div>
      {failedCode === code && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t("mermaidUpdateFailed")}</p>
      )}
      <details className="border-t">
        <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">{t("mermaidSource")}</summary>
        {children}
      </details>
    </>
  )
}
