"use client"

import * as React from "react"
import { Activity, Cable, CheckCircle2, FolderOpen, Loader2, Play, RotateCcw, Settings2, Square, Terminal, Unplug, Wifi } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  connectorDesktop,
  type ConnectorConfig,
  type ConnectorLog,
  type ConnectorState,
  logMessage,
  type PairingState,
} from "@/lib/connector-rpc"

const defaultConfig: ConnectorConfig = {
  serverUrl: "",
  connectorId: "",
  connectorToken: "",
  heartbeatSeconds: 20,
  reconnectSeconds: 3,
  syncExistingOnConnect: true,
  syncIntervalSeconds: 30,
  stateDbPath: null,
}

export function DesktopShell() {
  const [state, setState] = React.useState<ConnectorState | null>(null)
  const [config, setConfig] = React.useState<ConnectorConfig>(defaultConfig)
  const [logs, setLogs] = React.useState<ConnectorLog[]>([])
  const [pairing, setPairing] = React.useState<PairingState | null>(null)
  const [server, setServer] = React.useState("")
  const [busy, setBusy] = React.useState<string | null>(null)
  const [bridgeError, setBridgeError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cleanup: Array<() => void> = []
    async function boot() {
      try {
        const api = connectorDesktop()
        const [nextState, nextConfig] = await Promise.all([api.getState(), api.getConfig()])
        setState(nextState)
        setConfig({ ...defaultConfig, ...nextConfig })
        cleanup = [
          api.onState(setState),
          api.onPairing(setPairing),
          api.onLog((entry) => setLogs((current) => [...current.slice(-299), entry])),
        ]
      } catch (error) {
        setBridgeError(error instanceof Error ? error.message : String(error))
      }
    }
    void boot()
    return () => {
      for (const dispose of cleanup) dispose()
    }
  }, [])

  async function run<T>(label: string, action: () => Promise<T>, success?: string): Promise<T | null> {
    setBusy(label)
    try {
      const result = await action()
      if (success) toast.success(success)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(message)
      return null
    } finally {
      setBusy(null)
    }
  }

  async function saveConfig() {
    const saved = await run("save", () => connectorDesktop().saveConfig(config), "Configuration saved")
    if (saved) setConfig({ ...defaultConfig, ...saved })
  }

  async function startConnector() {
    const next = await run("start", () => connectorDesktop().start(), "Connector started")
    if (next) setState(next)
  }

  async function stopConnector() {
    const next = await run("stop", () => connectorDesktop().stop(), "Connector stopped")
    if (next) setState(next)
  }

  async function restartConnector() {
    const next = await run("restart", () => connectorDesktop().restart(), "Connector restarted")
    if (next) setState(next)
  }

  async function startPairing() {
    const next = await run("pairing", () => connectorDesktop().startPairing({ server }), "Pairing started")
    if (next) setPairing(next)
  }

  async function cancelPairing() {
    const next = await run("cancelPairing", () => connectorDesktop().cancelPairing())
    if (next) setPairing(next)
  }

  const isRunning = Boolean(state?.running)
  const status = state?.status ?? "loading"

  return (
    <div className="flex h-screen min-h-0 bg-background text-foreground">
      <aside className="drag-region flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="flex h-16 items-center gap-3 px-5">
          <div className="flex size-9 items-center justify-center rounded-lg border bg-background">
            <Cable className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Agents Anywhere</div>
            <div className="truncate text-xs text-muted-foreground">Connector Desktop</div>
          </div>
        </div>
        <nav className="no-drag flex flex-1 flex-col gap-1 px-3 py-2 text-sm">
          <NavItem icon={Activity} label="Overview" active />
          <NavItem icon={Settings2} label="Configuration" />
          <NavItem icon={Terminal} label="Logs" />
        </nav>
        <div className="no-drag border-t p-4">
          <StatusBadge status={status} running={isRunning} />
          <div className="mt-3 truncate text-xs text-muted-foreground">{state?.configPath || "No config path loaded"}</div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="drag-region flex h-14 shrink-0 items-center justify-between border-b px-5">
          <div>
            <h1 className="text-sm font-semibold">Local connector</h1>
            <p className="text-xs text-muted-foreground">Manage the connector runtime used by this machine.</p>
          </div>
          <div className="no-drag flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={restartConnector} disabled={Boolean(busy)}>
              <RotateCcw className="size-4" />
              Restart
            </Button>
            {isRunning ? (
              <Button variant="destructive" size="sm" onClick={stopConnector} disabled={Boolean(busy)}>
                <Square className="size-4" />
                Stop
              </Button>
            ) : (
              <Button size="sm" onClick={startConnector} disabled={Boolean(busy) || !state?.hasConfig}>
                <Play className="size-4" />
                Start
              </Button>
            )}
          </div>
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-5">
            {bridgeError ? <BridgeError message={bridgeError} /> : null}

            <section className="grid gap-4 md:grid-cols-3">
              <Metric title="Status" value={status} detail={state?.lastError || (isRunning ? "Runtime is connected locally" : "Runtime is idle")} />
              <Metric title="Configuration" value={state?.hasConfig ? "Saved" : "Missing"} detail={state?.configPath || "Connector config not loaded"} />
              <Metric title="Pairing" value={pairing?.status || (state?.pairing ? "Active" : "Idle")} detail={pairing?.code ? `Code ${pairing.code}` : "No active pairing code"} />
            </section>

            <Tabs defaultValue="setup" className="w-full">
              <TabsList>
                <TabsTrigger value="setup">Setup</TabsTrigger>
                <TabsTrigger value="config">Config</TabsTrigger>
                <TabsTrigger value="logs">Logs</TabsTrigger>
              </TabsList>

              <TabsContent value="setup" className="mt-4">
                <Card>
                  <CardHeader>
                    <CardTitle>Pair this machine</CardTitle>
                    <CardDescription>Start a pairing flow from the connector process. The code is claimed from the web console.</CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-4 md:grid-cols-[1fr_auto]">
                    <div className="grid gap-2">
                      <Label htmlFor="pair-server">Server</Label>
                      <Input id="pair-server" value={server} onChange={(event) => setServer(event.target.value)} placeholder="https://your-agents-anywhere.example" />
                    </div>
                    <div className="flex items-end gap-2">
                      <Button onClick={startPairing} disabled={Boolean(busy) || !server.trim()}>
                        {busy === "pairing" ? <Loader2 className="size-4 animate-spin" /> : <Wifi className="size-4" />}
                        Pair
                      </Button>
                      <Button variant="outline" onClick={cancelPairing} disabled={!pairing || pairing.status === "cancelled"}>
                        Cancel
                      </Button>
                    </div>
                    {pairing ? <PairingPanel pairing={pairing} /> : null}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="config" className="mt-4">
                <Card>
                  <CardHeader>
                    <CardTitle>Connector configuration</CardTitle>
                    <CardDescription>Stored locally and passed to the connector runtime.</CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <Field label="Server URL" value={config.serverUrl} onChange={(value) => setConfig((current) => ({ ...current, serverUrl: value }))} />
                      <Field label="Connector ID" value={config.connectorId} onChange={(value) => setConfig((current) => ({ ...current, connectorId: value }))} />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="token">Connector token</Label>
                      <Textarea id="token" className="min-h-24 font-mono text-xs" value={config.connectorToken} onChange={(event) => setConfig((current) => ({ ...current, connectorToken: event.target.value }))} />
                    </div>
                    <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                      <div>
                        <div className="text-sm font-medium">Sync existing sessions</div>
                        <div className="text-xs text-muted-foreground">Ask the runtime to publish existing local sessions after connect.</div>
                      </div>
                      <Switch checked={config.syncExistingOnConnect !== false} onCheckedChange={(checked) => setConfig((current) => ({ ...current, syncExistingOnConnect: checked }))} />
                    </div>
                    <div className="flex items-center justify-between">
                      <Button variant="outline" onClick={() => void connectorDesktop().openConfigFolder()}>
                        <FolderOpen className="size-4" />
                        Open config folder
                      </Button>
                      <Button onClick={saveConfig} disabled={Boolean(busy)}>
                        <CheckCircle2 className="size-4" />
                        Save config
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="logs" className="mt-4">
                <Card>
                  <CardHeader className="flex-row items-center justify-between space-y-0">
                    <div>
                      <CardTitle>Connector logs</CardTitle>
                      <CardDescription>Forwarded from connector loguru output over JSON-RPC.</CardDescription>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setLogs([])}>
                      Clear
                    </Button>
                  </CardHeader>
                  <CardContent>
                    <LogList logs={logs} />
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>
        </ScrollArea>
      </main>
    </div>
  )
}

function NavItem({ icon: Icon, label, active = false }: { icon: React.ElementType; label: string; active?: boolean }) {
  return (
    <button className={cn("flex h-9 items-center gap-2 rounded-md px-3 text-left text-muted-foreground", active && "bg-sidebar-accent text-sidebar-accent-foreground")}>
      <Icon className="size-4" />
      {label}
    </button>
  )
}

function StatusBadge({ status, running }: { status: string; running: boolean }) {
  return (
    <Badge variant={running ? "default" : status === "error" ? "destructive" : "secondary"} className="gap-1">
      {running ? <Wifi className="size-3" /> : <Unplug className="size-3" />}
      {status}
    </Badge>
  )
}

function Metric({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-xl">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = React.useId()
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  )
}

function PairingPanel({ pairing }: { pairing: PairingState }) {
  return (
    <div className="md:col-span-2 rounded-lg border bg-muted/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Pairing status: {pairing.status}</div>
          <div className="text-xs text-muted-foreground">{pairing.serverUrl || pairing.error || "Waiting for server response"}</div>
        </div>
        {pairing.code ? <div className="rounded-md border bg-background px-3 py-1 font-mono text-lg font-semibold tracking-wider">{pairing.code}</div> : null}
      </div>
    </div>
  )
}

function LogList({ logs }: { logs: ConnectorLog[] }) {
  if (logs.length === 0) {
    return <div className="flex h-64 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">No logs yet</div>
  }
  return (
    <div className="h-80 overflow-auto rounded-lg border bg-muted/20 p-3 font-mono text-xs">
      {logs.map((log, index) => (
        <div key={`${log.time || index}-${index}`} className="grid grid-cols-[88px_72px_1fr] gap-2 py-0.5">
          <span className="text-muted-foreground">{log.time ? new Date(log.time).toLocaleTimeString() : "--:--:--"}</span>
          <span className={cn("text-muted-foreground", log.level === "ERROR" && "text-destructive", log.level === "WARNING" && "text-yellow-600")}>{log.level || "INFO"}</span>
          <span className="min-w-0 break-words">{logMessage(log)}</span>
        </div>
      ))}
    </div>
  )
}

function BridgeError({ message }: { message: string }) {
  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle>Desktop bridge unavailable</CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
    </Card>
  )
}
