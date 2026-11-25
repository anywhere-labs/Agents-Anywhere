"use client"

// Getting an agent onto a device, from its row on the device page. Three ways, the same on every agent: one click (the
// device runs the agent's own install command, without a terminal; its output shows here and it can be cancelled), the
// same command copied into a terminal of the device, or the path of a program that is installed but was not found. An
// agent that is there but not what starts it (Node.js's `npx`) is told so instead: installing it again would not help.
import { useEffect, useState } from "react"
import { ExternalLinkIcon, LoaderCircleIcon, TerminalIcon } from "lucide-react"
import { MeshCallError } from "meshcall/web"
import { toast } from "sonner"

import { CopyButton } from "@/components/copy-button"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AgentIcon } from "@/components/workbench/agent-icon"
import { Card, Group } from "@/components/workbench/settings-parts"
import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import type { AgentEntry, DeviceRecord } from "@/lib/types/v3"
import { isInstalled, isInstalling, preferredMethod } from "@/lib/workbench/agents"

type TunnelDevice = Pick<DeviceRecord, "id" | "mode_hint" | "presence">

const METHOD_NAMES: Record<string, string> = { npm: "npm", brew: "Homebrew", winget: "WinGet", uv: "uv" }
/** What starts an agent besides its own program, and where to get it. */
const LAUNCHERS: Record<string, { name: string; href: string }> = {
  npx: { name: "Node.js", href: "https://nodejs.org" },
}

export function AgentInstallDialog({
  open,
  onOpenChange,
  tunnelManager,
  device,
  entry,
  onEntry,
  onSearch,
  onOpenTerminal,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  entry: AgentEntry | null
  onEntry: (entry: AgentEntry) => void
  /** Look for the agents again. */
  onSearch: () => Promise<void>
  /** Open a terminal of the device (the command has been copied). */
  onOpenTerminal: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(760px,calc(100dvh-4rem))] flex-col gap-0 p-0 sm:max-w-xl">
        {open && entry && (
          <AgentInstallBody
            key={`${device?.id}:${entry.id}`}
            tunnelManager={tunnelManager}
            device={device}
            entry={entry}
            onEntry={onEntry}
            onSearch={onSearch}
            onOpenTerminal={onOpenTerminal}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function AgentInstallBody({
  tunnelManager,
  device,
  entry,
  onEntry,
  onSearch,
  onOpenTerminal,
  onClose,
}: {
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  entry: AgentEntry
  onEntry: (entry: AgentEntry) => void
  onSearch: () => Promise<void>
  onOpenTerminal: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const online = device?.presence === "online"
  const methods = entry.install?.methods ?? []
  const job = entry.install?.job
  const installing = isInstalling(job)
  const [methodId, setMethodId] = useState(() => (installing ? job?.method : preferredMethod(entry)) ?? "")
  const [program, setProgram] = useState("")
  const [pending, setPending] = useState<"install" | "cancel" | "program" | "search" | null>(null)
  const launcher = entry.missing ? (LAUNCHERS[entry.missing] ?? { name: entry.missing, href: undefined }) : null
  const method = methods.find((m) => m.id === methodId) ?? methods[0]
  const installed = isInstalled(entry)

  // Installed meanwhile (here, in a terminal, or from another window): there is nothing left to do here. The page says so.
  useEffect(() => {
    if (installed) onClose()
  }, [installed, onClose])

  const run = async (what: "install" | "cancel" | "program", task: (manager: DeviceTunnelManager, device: TunnelDevice) => Promise<AgentEntry>) => {
    if (!tunnelManager || !device) return
    setPending(what)
    try {
      onEntry(await task(tunnelManager, device))
    } catch (err) {
      const reason = err instanceof MeshCallError ? err.reason : undefined
      toast.error(
        reason === "program_not_found"
          ? t("install.programNotFound")
          : reason === "program_path_relative"
            ? t("install.programRelative")
            : err instanceof Error
              ? err.message
              : String(err)
      )
    } finally {
      setPending(null)
    }
  }

  const search = async () => {
    setPending("search")
    await onSearch()
    setPending(null)
  }

  const copyAndOpen = async () => {
    if (!method) return
    try {
      await navigator.clipboard.writeText(method.command)
      toast.success(t("install.copied"))
    } catch {
      toast.error(t("common.copyFailed"))
    }
    onOpenTerminal()
  }

  let status: string | null = null
  if (job?.state === "waiting") status = t("install.waiting")
  else if (job?.state === "cancelled") status = t("install.cancelled")
  else if (job?.state === "failed") status = job.error ? t("install.failedBecause", { error: job.error }) : t("install.failed", { code: job.exit_code ?? "?" })
  else if (job?.state === "succeeded") status = t("install.notFound")

  return (
    <>
      <DialogHeader className="flex-row items-center gap-3 border-b border-border px-6 py-4 text-left">
        <AgentIcon agent={entry.id} name={entry.name} className="size-6 shrink-0" />
        <div className="min-w-0 space-y-0.5">
          <DialogTitle className="truncate">{t("install.title", { agent: entry.name })}</DialogTitle>
          <DialogDescription className="truncate">{t("install.subtitle")}</DialogDescription>
        </div>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
        {launcher && (
          <div className="space-y-3 rounded-2xl bg-card p-4">
            <div className="space-y-1">
              <p className="text-sm text-foreground">{t("install.missing", { agent: entry.name, program: entry.missing ?? "" })}</p>
              <p className="text-sm text-muted-foreground">{t("install.missingHint", { name: launcher.name })}</p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {launcher.href && (
                <Button
                  variant="outline"
                  size="sm"
                  render={<a href={launcher.href} target="_blank" rel="noreferrer" />}
                  nativeButton={false}
                >
                  {launcher.name}
                  <ExternalLinkIcon className="size-3.5" />
                </Button>
              )}
              <Button size="sm" disabled={pending !== null || !online} onClick={() => void search()}>
                {pending === "search" && <LoaderCircleIcon className="size-3.5 animate-spin" />}
                {t("install.search")}
              </Button>
            </div>
          </div>
        )}

        {!launcher && method && (
          <Group
            title={t("install.command")}
            action={
              entry.website && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground"
                  render={<a href={entry.website} target="_blank" rel="noreferrer" />}
                  nativeButton={false}
                >
                  {t("install.docs")}
                  <ExternalLinkIcon className="size-3.5" />
                </Button>
              )
            }
          >
            <div className="space-y-3 rounded-2xl bg-card p-4">
              {methods.length > 1 && (
                <Tabs value={method.id} onValueChange={(v) => setMethodId(String(v))}>
                  <TabsList variant="pill" scrollable>
                    {methods.map((m) => (
                      <TabsTrigger key={m.id} value={m.id} disabled={installing}>
                        {METHOD_NAMES[m.id] ?? t("install.script")}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              )}
              <div className="flex items-start gap-1 rounded-lg bg-background py-1.5 pr-1.5 pl-3">
                <code className="min-w-0 flex-1 py-1 font-mono text-sm break-all">{method.command}</code>
                <CopyButton value={method.command} copyLabel={t("common.copy")} copyFailedLabel={t("common.copyFailed")} />
              </div>
              {!method.available && <p className="text-xs text-muted-foreground">{t("install.needs", { program: method.needs ?? "" })}</p>}
              <div className="flex flex-wrap items-center justify-end gap-2">
                {installing ? (
                  <Button variant="outline" size="sm" disabled={pending !== null || !online} onClick={() => void run("cancel", (m, d) => m.cancelInstall(d, entry.id))}>
                    {pending === "cancel" && <LoaderCircleIcon className="size-3.5 animate-spin" />}
                    {t("common.cancel")}
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" disabled={!online} onClick={() => void copyAndOpen()}>
                    <TerminalIcon className="size-3.5" />
                    {t("install.terminal")}
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={installing || pending !== null || !online || !method.available}
                  onClick={() => void run("install", (m, d) => m.installAgent(d, entry.id, method.id))}
                >
                  {(installing || pending === "install") && <LoaderCircleIcon className="size-3.5 animate-spin" />}
                  {installing ? t("install.running") : t("install.oneClick")}
                </Button>
              </div>
              {job && (status || job.output) && (
                <div className="space-y-2 border-t border-border pt-3">
                  {status && (
                    <p className={job.state === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{status}</p>
                  )}
                  {job.output && (
                    <pre className="max-h-48 overflow-y-auto rounded-lg bg-background px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">
                      {job.output}
                    </pre>
                  )}
                </div>
              )}
            </div>
          </Group>
        )}

        {!launcher && entry.install && (
          <Group title={t("install.already")} description={t("install.alreadyHint", { agent: entry.name })}>
            <Card>
              <form
                className="flex items-center gap-2 py-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (program.trim()) void run("program", (m, d) => m.updateAgent(d, { id: entry.id, program: program.trim() }))
                }}
              >
                <Input
                  value={program}
                  onChange={(e) => setProgram(e.target.value)}
                  placeholder="/usr/local/bin/…"
                  aria-label={t("install.path")}
                  className="font-mono text-sm"
                  spellCheck={false}
                />
                <Button type="submit" variant="outline" size="sm" disabled={!program.trim() || pending !== null || !online}>
                  {pending === "program" && <LoaderCircleIcon className="size-3.5 animate-spin" />}
                  {t("install.use")}
                </Button>
              </form>
            </Card>
          </Group>
        )}
      </div>
    </>
  )
}
