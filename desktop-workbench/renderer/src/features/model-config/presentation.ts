import type {
  DeviceRuntimeView,
  ModelAssignmentStatus,
  ModelConnectionState,
  ModelPreferences,
  ModelSpec,
  RuntimeMaturity,
} from "@/features/dashboard/types"

export type ModelStatusTone = "ok" | "progress" | "warning" | "error" | "neutral"

/** Stable runtimes show no badge; the others say how far along they are. */
export function maturityBadge(maturity: RuntimeMaturity | null | undefined): "experimental" | "beta" | null {
  return maturity === "beta" || maturity === "experimental" ? maturity : null
}

export function connectionStateTone(state: ModelConnectionState | undefined): ModelStatusTone {
  if (state === "applied") return "ok"
  if (state === "saved_pending") return "progress"
  if (state === "failed") return "error"
  if (state === "managed_externally") return "warning"
  return "neutral"
}

export function assignmentStatusTone(status: ModelAssignmentStatus): ModelStatusTone {
  if (status === "applied") return "ok"
  if (status === "applying") return "progress"
  if (status === "failed") return "error"
  return "warning"
}

/** Runtimes the page lists: every instance that declares a model connection. */
export function modelConfigurableRuntimes(runtimes: DeviceRuntimeView[]): DeviceRuntimeView[] {
  return runtimes.filter((runtime) => Boolean(runtime.modelConnection))
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Model IDs parsed from a free-form list: one per line or separated by commas. */
export function parseModelIds(text: string): string[] {
  const seen = new Set<string>()
  for (const raw of text.split(/[\n,]/)) {
    const id = raw.trim()
    if (id) seen.add(id)
  }
  return [...seen]
}

export type QuickSetupPhase = "setup" | "progress" | "done"
export type QuickStepStatus = "pending" | "active" | "done" | "failed"
type QuickTokens = {
  link: { status: "linked" | "reauth_required" } | null
  quickSetup?: { state: "syncing" | "applying" | "done" | "failed"; step?: "sync" | "apply" } | null
}
type QuickCandidate = {
  connectorId: string
  runtimeId: string
  decision: "apply" | "skip"
  requiresConfirmation?: boolean
}

export const quickTargetKey = (target: { connectorId: string; runtimeId: string }) =>
  `${target.connectorId}/${target.runtimeId}`

/**
 * Which face the Tokens Anywhere card shows: choosing what to set up, a setup
 * on its way (including the browser authorization this page started), or the
 * result once runtimes use the Tokens profile.
 */
export function quickSetupPhase(tokens: QuickTokens, configured: boolean, authorizing: boolean): QuickSetupPhase {
  const state = tokens.quickSetup?.state
  const linked = tokens.link?.status === "linked"
  if (authorizing && !linked) return "progress"
  // A linked account shows its own page; once runtimes use Tokens, later runs
  // (new runtimes, changed models) show there too.
  if (linked && configured && state !== "failed") return "done"
  if (state === "syncing" || state === "applying" || state === "failed") return linked ? "progress" : "setup"
  return linked ? "done" : "setup"
}

/** A setup or a model change is being written to runtimes right now. */
export function quickSetupRunning(tokens: QuickTokens): boolean {
  const state = tokens.quickSetup?.state
  return state === "syncing" || state === "applying"
}

export function quickSetupSteps(tokens: QuickTokens, authorizing: boolean): Record<"authorize" | "sync" | "apply", QuickStepStatus> {
  const linked = tokens.link?.status === "linked"
  const progress = tokens.quickSetup
  if (!linked) return { authorize: authorizing ? "active" : "pending", sync: "pending", apply: "pending" }
  if (!progress) return { authorize: "done", sync: "pending", apply: "pending" }
  if (progress.state === "failed") {
    return progress.step === "sync"
      ? { authorize: "done", sync: "failed", apply: "pending" }
      : { authorize: "done", sync: "done", apply: "failed" }
  }
  if (progress.state === "syncing") return { authorize: "done", sync: "active", apply: "pending" }
  if (progress.state === "applying") return { authorize: "done", sync: "done", apply: "active" }
  return { authorize: "done", sync: "done", apply: "done" }
}

/** Ticked by default: everything that can be applied without changing a runtime's own global settings. */
export function defaultQuickSelection(candidates: QuickCandidate[]): Set<string> {
  return new Set(candidates.filter((item) => item.decision === "apply" && !item.requiresConfirmation).map(quickTargetKey))
}

/**
 * Runtimes that could use Tokens Anywhere but do not yet. A runtime served by
 * a managed instance counts as set up: the instance carries the assignment.
 */
export function newQuickCandidates<T extends QuickCandidate & { runtimeType?: string; effect?: string }>(
  candidates: T[],
  assigned: { connectorId: string; runtimeId: string; runtimeType?: string; createdRuntime?: boolean }[],
): T[] {
  const taken = new Set(assigned.map(quickTargetKey))
  const managed = new Set(assigned.filter((item) => item.createdRuntime && item.runtimeType).map((item) => `${item.connectorId}/${item.runtimeType}`))
  return candidates.filter((item) => item.decision === "apply"
    && !taken.has(quickTargetKey(item))
    && !(item.effect === "new_instance" && managed.has(`${item.connectorId}/${item.runtimeType}`)))
}

// Tokens Anywhere models and usage.

type ProfileModels = {
  offers: { models: ModelSpec[] }[]
  preferences?: ModelPreferences
}

export type TokensModel = {
  id: string
  /** The name Tokens Anywhere gives it, or its ID. */
  originalName: string
  vendor: string | null
  contextWindow: number | null
  maxOutputTokens: number | null
  image: boolean
}

/** Each model once, across the protocols the profile offers it on. */
export function tokensModels(profile: ProfileModels): TokensModel[] {
  const byId = new Map<string, TokensModel>()
  for (const offer of profile.offers) {
    for (const spec of offer.models) {
      const known = byId.get(spec.id)
      const knownName = known && known.originalName !== known.id ? known.originalName : null
      byId.set(spec.id, {
        id: spec.id,
        originalName: knownName ?? (spec.name || spec.id),
        vendor: known?.vendor ?? spec.vendor ?? null,
        contextWindow: known?.contextWindow ?? spec.contextWindow ?? null,
        maxOutputTokens: known?.maxOutputTokens ?? spec.maxOutputTokens ?? null,
        image: Boolean(known?.image) || Boolean(spec.input?.includes("image")),
      })
    }
  }
  return [...byId.values()]
}

const VENDOR_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  gemini: "Google",
  deepseek: "DeepSeek",
  moonshot: "Moonshot",
  moonshotai: "Moonshot",
  qwen: "Qwen",
  alibaba: "Qwen",
  zhipu: "Zhipu",
  "z-ai": "Zhipu",
  xai: "xAI",
  minimax: "MiniMax",
  mistral: "Mistral",
}

export function vendorLabel(vendor: string | null): string | null {
  if (!vendor) return null
  return VENDOR_LABELS[vendor.toLowerCase()] ?? vendor
}

export type VendorGroup = { key: string; label: string | null; models: TokensModel[] }

/** Models by maker, the best known first; models with no maker come last. */
export function vendorGroups(models: TokensModel[]): VendorGroup[] {
  const groups = new Map<string, VendorGroup>()
  for (const model of models) {
    const label = vendorLabel(model.vendor)
    const key = label ?? ""
    const group = groups.get(key) ?? { key, label, models: [] }
    group.models.push(model)
    groups.set(key, group)
  }
  const order = Object.values(VENDOR_LABELS)
  const rank = (label: string | null) => (label === null ? Number.MAX_SAFE_INTEGER : order.includes(label) ? order.indexOf(label) : order.length)
  return [...groups.values()].sort((a, b) => rank(a.label) - rank(b.label) || (a.label ?? "").localeCompare(b.label ?? ""))
}

/** A token count the way model sizes are said: 200K, 1M, 1.5M. */
export function formatTokenWindow(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`
  return String(value)
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set([...a, ...b]).size === a.length

export function samePreferences(a: ModelPreferences, b: ModelPreferences): boolean {
  const names = (value: ModelPreferences) => Object.entries(value.names).filter(([, name]) => name.trim())
  const left = names(a)
  const right = names(b)
  return sameSet(a.disabled, b.disabled)
    && left.length === right.length
    && left.every(([id, name]) => b.names[id]?.trim() === name.trim())
}

/** Preferences as saved: only names that differ from the model's own, only models still offered. */
export function cleanPreferences(preferences: ModelPreferences, models: TokensModel[]): ModelPreferences {
  const byId = new Map(models.map((model) => [model.id, model]))
  return {
    disabled: preferences.disabled.filter((id) => byId.has(id)),
    names: Object.fromEntries(
      Object.entries(preferences.names)
        .map(([id, name]) => [id, name.trim()] as const)
        .filter(([id, name]) => name && byId.has(id) && name !== byId.get(id)?.originalName),
    ),
  }
}

/**
 * Amounts in ten-thousandths of a yuan. Tokens Anywhere sends decimal strings
 * with four places; adding them as integers keeps sums exact.
 */
export function amountUnits(value: string | null | undefined): number {
  const match = /^(-)?(\d+)(?:\.(\d{1,4}))?$/.exec((value ?? "").trim())
  if (!match) return 0
  const units = Number(match[2]) * 10_000 + Number((match[3] ?? "").padEnd(4, "0"))
  return match[1] ? -units : units
}

/** Yuan with two places, or four when two would show a small cost as nothing. */
export function formatYuan(units: number): string {
  const yuan = units / 10_000
  const digits = units !== 0 && Math.abs(units) < 100 ? 4 : 2
  return `¥${yuan.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

type UsageRow = {
  date: string
  model: string | null
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  amountCharged: string
}

export type UsageSummary = {
  cost: number
  requests: number
  tokens: number
  daily: { date: string; cost: number }[]
  models: { model: string; requests: number; tokens: number; cost: number }[]
}

const rowTokens = (row: UsageRow) =>
  (row.inputTokens ?? 0) + (row.outputTokens ?? 0) + (row.cacheReadTokens ?? 0)
  + (row.cacheWrite5mTokens ?? 0) + (row.cacheWrite1hTokens ?? 0)

function datesBetween(from: string, to: string): string[] {
  const dates: string[] = []
  const day = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  while (day <= end && dates.length < 400) {
    dates.push(day.toISOString().slice(0, 10))
    day.setUTCDate(day.getUTCDate() + 1)
  }
  return dates
}

/** Totals, cost per day (every day, quiet ones as zero) and per model, most spent first. */
export function summarizeUsage(usage: { from: string; to: string; items: UsageRow[] }, model: string | null): UsageSummary {
  const rows = usage.items.filter((row) => model === null || row.model === model)
  const perDay = new Map(datesBetween(usage.from, usage.to).map((date) => [date, 0]))
  const perModel = new Map<string, { model: string; requests: number; tokens: number; cost: number }>()
  let cost = 0
  let requests = 0
  let tokens = 0
  for (const row of rows) {
    const units = amountUnits(row.amountCharged)
    cost += units
    requests += row.requests ?? 0
    tokens += rowTokens(row)
    perDay.set(row.date, (perDay.get(row.date) ?? 0) + units)
    const key = row.model ?? ""
    const entry = perModel.get(key) ?? { model: key, requests: 0, tokens: 0, cost: 0 }
    entry.requests += row.requests ?? 0
    entry.tokens += rowTokens(row)
    entry.cost += units
    perModel.set(key, entry)
  }
  return {
    cost,
    requests,
    tokens,
    daily: [...perDay.entries()].map(([date, units]) => ({ date, cost: units })),
    models: [...perModel.values()].sort((a, b) => b.cost - a.cost || b.requests - a.requests),
  }
}
