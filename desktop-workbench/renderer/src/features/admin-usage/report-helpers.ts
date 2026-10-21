// Pure helpers for the admin usage dashboard: date ranges in the viewer's
// timezone and value formatting. Kept free of React so they can be unit tested
// with node:test.

export type UsageRangePreset = "7d" | "30d" | "90d" | "custom"

export type UsageDateRange = {
  from: string
  to: string
}

const PRESET_DAYS: Record<Exclude<UsageRangePreset, "custom">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/** Calendar date (YYYY-MM-DD) of `now` in the given IANA timezone. */
export function localToday(timeZone: string, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now)
    const read = (type: string) => parts.find((part) => part.type === type)?.value ?? ""
    const value = `${read("year")}-${read("month")}-${read("day")}`
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  } catch {
    // fall through to UTC
  }
  return now.toISOString().slice(0, 10)
}

export function shiftDate(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}

export function presetRange(preset: UsageRangePreset, today: string): UsageDateRange {
  if (preset === "custom") return { from: today, to: today }
  return { from: shiftDate(today, -(PRESET_DAYS[preset] - 1)), to: today }
}

export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function clampRange(range: UsageDateRange, maxDays = 366): UsageDateRange | null {
  if (!isValidDate(range.from) || !isValidDate(range.to)) return null
  if (range.from > range.to) return null
  const span = (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000 + 1
  if (span > maxDays) return null
  return range
}

export function formatNumber(value: number | null | undefined, locale?: string): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—"
  return value.toLocaleString(locale)
}

export function formatCompactNumber(value: number, locale?: string): string {
  if (Math.abs(value) < 1000) return value.toLocaleString(locale)
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value)
}

export function formatPercent(value: number | null | undefined, fractionDigits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—"
  return `${(value * 100).toFixed(fractionDigits)}%`
}

export function formatDurationMs(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value) || value < 0) return "—"
  if (value < 1000) return `${Math.round(value)} ms`
  const seconds = value / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes - hours * 60).padStart(2, "0")}m`
}

/** "2026-10-05" -> "10-05" for axis ticks. */
export function formatShortDate(value: string | number): string {
  const text = String(value)
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.slice(5) : text
}

export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`
}

export function segmentRangeLabel(min: number, max: number | null): string {
  if (max === null) return `≥ ${min}`
  if (max <= min) return `${min}`
  return `${min}–${max}`
}
