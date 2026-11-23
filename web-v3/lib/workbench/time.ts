// Short relative times for lists ("3 min", "2 h", "5 d"), localised with Intl.

export function shortAgo(iso: string | number | undefined | null, locale: "en" | "zh-CN", now = Date.now()): string {
  if (iso == null || iso === "") return ""
  const t = typeof iso === "number" ? iso : Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const s = Math.max(0, Math.round((now - t) / 1000))
  const zh = locale === "zh-CN"
  if (s < 60) return zh ? "刚刚" : "now"
  const m = Math.round(s / 60)
  if (m < 60) return zh ? `${m} 分钟` : `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return zh ? `${h} 小时` : `${h}h`
  const d = Math.round(h / 24)
  if (d < 7) return zh ? `${d} 天` : `${d}d`
  const w = Math.round(d / 7)
  if (d < 35) return zh ? `${w} 周` : `${w}w`
  return new Intl.DateTimeFormat(zh ? "zh-CN" : "en-US", { month: "short", day: "numeric" }).format(t)
}

/** "1.2 MB" */
export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}
