// The agents of a device as its page lists them: the installed ones and, apart from them, the ones that can be
// installed, each by name.
import type { AgentEntry, AgentInstallJob } from "@/lib/types/v3"

/** By name, whatever its case, digits by their value. */
export function byName(a: { name: string; id: string }, b: { name: string; id: string }): number {
  return a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true }) || a.id.localeCompare(b.id, "en")
}

/** Whether the agent can be used on its device. A Connector that does not say lists installed agents only. */
export function isInstalled(entry: Pick<AgentEntry, "installed"> | null | undefined): boolean {
  return entry?.installed ?? true
}

export function isInstalling(job: Pick<AgentInstallJob, "state"> | undefined): boolean {
  return job?.state === "waiting" || job?.state === "running"
}

/** Whether a gateway's address can be used: http(s), without a user, query or fragment. */
export function isGatewayUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !/[?#]/.test(value)
}

/** A key entered for one host is not sent to another: the saved one counts only while the address stays on its host. */
export function keepsGatewayKey(savedUrl: string | undefined, url: string): boolean {
  return Boolean(savedUrl) && isGatewayUrl(url) && new URL(savedUrl as string).origin === new URL(url).origin
}

/** An agent as a device's page lists it: as the device reports it, and what the page knows besides. */
export interface ListedAgent {
  id: string
  name: string
  /** `null`: a Connector that does not manage agents. */
  entry: AgentEntry | null
  installed: boolean
  enabled: boolean
  running: boolean
  /** Its conversations on the device. */
  count: number
}

/**
 * The agents that are there (or that the user added, whose command may be gone, or that only miss what starts them) and
 * apart from them the ones that can be installed, each by name.
 */
export function splitAgents(agents: readonly ListedAgent[]): { usable: ListedAgent[]; more: ListedAgent[] } {
  const sorted = [...agents].sort(byName)
  const isThere = (a: ListedAgent) => a.installed || a.entry?.missing !== undefined || a.entry?.install === undefined
  return { usable: sorted.filter(isThere), more: sorted.filter((a) => !isThere(a)) }
}

/** What happened to an agent between two reads of a device's agents. */
export interface InstallNews {
  kind: "installed" | "failed"
  entry: AgentEntry
}

/** Agents that are there now and were not before, and installs that have failed since. */
export function installNews(before: readonly AgentEntry[], now: readonly AgentEntry[]): InstallNews[] {
  return now.flatMap((entry): InstallNews[] => {
    const was = before.find((e) => e.id === entry.id)
    if (!was) return []
    if (!isInstalled(was) && isInstalled(entry)) return [{ kind: "installed", entry }]
    const ended = isInstalling(was.install?.job) && !isInstalling(entry.install?.job)
    // One that ended without the program being there failed, whatever its exit code says.
    return ended && !isInstalled(entry) && entry.install?.job?.state !== "cancelled" ? [{ kind: "failed", entry }] : []
  })
}

/** The method offered first: the preferred one whose program is there, else the preferred one. */
export function preferredMethod(entry: Pick<AgentEntry, "install"> | null): string | undefined {
  const methods = entry?.install?.methods ?? []
  return (methods.find((m) => m.available) ?? methods[0])?.id
}
