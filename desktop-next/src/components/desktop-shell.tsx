"use client"

import * as React from "react"
import {
  Check,
  CheckCircle2,
  CircleAlert,
  Clipboard,
  Copy,
  FolderOpen,
  Loader2,
  Play,
  RotateCcw,
  Settings2,
  Square,
  Terminal,
  Wifi,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  connectorDesktop,
  type ConnectorConfig,
  type ConnectorLog,
  type ConnectorState,
  type DesktopSettings,
  logMessage,
  type PairingState,
} from "@/lib/connector-rpc"

type View = "overview" | "logs" | "settings"
type PairDialogStep = "input" | "waiting" | "claimed" | "error"
type CommandDialogStep = "input" | "confirm"

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

const desktopMessages = {
  en: {
    appName: "Agents Anywhere",
    navOverview: "Overview",
    navLogs: "Logs",
    navSettings: "Settings",
    headerTitle: "Desktop Connector",
    headerSubtitle: "Connect this computer to Agents Anywhere.",
    runtimeStatus: "Connector",
    pairingStatus: "Pairing",
    start: "Start",
    stop: "Stop",
    restart: "Restart",
    startPairing: "Start pairing",
    startFromCommand: "Start from command",
    logs: "Logs",
    logsDescription: "Recent connector activity.",
    clear: "Clear",
    settings: "Settings",
    settingsDescription: "Startup and local connector options.",
    launchAtLogin: "Open at login",
    launchAtLoginHint: "Open the desktop app when you sign in.",
    startOnLaunch: "Start connector on launch",
    startOnLaunchHint: "Start automatically when credentials are saved.",
    uvCommand: "uv command",
    configPath: "Config path",
    settingsPath: "Settings path",
    openConfigFolder: "Open config folder",
    pairingTitle: "Pair this machine",
    pairingDescription: "Enter your server address to get a pairing code.",
    pairingComplete: "Pairing complete",
    pairingCode: "Pairing code",
    pairingWaiting: "Waiting for claim in the web console.",
    pairingFailed: "Pairing failed",
    server: "Server",
    commandTitle: "Start from command",
    commandDescription: "Paste the start command from the web console.",
    commandLabel: "Start command",
    continue: "Continue",
    cancel: "Cancel",
    done: "Done",
    runOnce: "Run once",
    saveAndStart: "Save and start",
    copied: "Copied",
    noLogs: "No logs yet",
    bridgeUnavailable: "Desktop bridge unavailable",
    runtimeConnected: "Connected",
    runtimeIdle: "Not running",
    noPairingCode: "No active code",
    pairActionDescription: "Get a code and finish setup in the web console.",
    commandActionDescription: "Use the start command generated in the web console.",
    credentialsTitle: "Connector credentials",
    credentialsDescription: "Saved by pairing or command setup.",
    serverUrl: "Server URL",
    connectorId: "Connector ID",
    connectorToken: "Connector token",
    saveConfig: "Save config",
    savedStarting: "Saved. Starting connector.",
    parseStartCommand: "Paste a start command.",
    parseMissingValues: "This command is missing required values.",
    connectorStarted: "Connector started",
    connectorStopped: "Connector stopped",
    connectorRestarted: "Connector restarted",
    configSaved: "Configuration saved",
    pairingStarted: "Pairing started",
  },
  zh: {
    appName: "Agents Anywhere",
    navOverview: "概览",
    navLogs: "日志",
    navSettings: "设置",
    headerTitle: "Desktop Connector",
    headerSubtitle: "把这台电脑连接到 Agents Anywhere。",
    runtimeStatus: "连接器",
    pairingStatus: "配对",
    start: "启动",
    stop: "停止",
    restart: "重启",
    startPairing: "开始配对",
    startFromCommand: "从命令启动",
    logs: "日志",
    logsDescription: "最近的连接器活动。",
    clear: "清空",
    settings: "设置",
    settingsDescription: "启动项和本机连接器选项。",
    launchAtLogin: "登录时打开",
    launchAtLoginHint: "登录系统后打开桌面应用。",
    startOnLaunch: "打开应用后启动连接器",
    startOnLaunchHint: "已保存凭据时自动启动。",
    uvCommand: "uv 命令",
    configPath: "配置路径",
    settingsPath: "设置路径",
    openConfigFolder: "打开配置文件夹",
    pairingTitle: "配对这台电脑",
    pairingDescription: "输入服务器地址，生成配对码。",
    pairingComplete: "配对完成",
    pairingCode: "配对码",
    pairingWaiting: "等待在 Web 控制台认领。",
    pairingFailed: "配对失败",
    server: "服务器",
    commandTitle: "从命令启动",
    commandDescription: "粘贴 Web 控制台生成的启动命令。",
    commandLabel: "启动命令",
    continue: "继续",
    cancel: "取消",
    done: "完成",
    runOnce: "仅本次启动",
    saveAndStart: "保存并启动",
    copied: "已复制",
    noLogs: "暂无日志",
    bridgeUnavailable: "桌面桥接不可用",
    runtimeConnected: "已连接",
    runtimeIdle: "未运行",
    noPairingCode: "没有配对码",
    pairActionDescription: "生成配对码，然后在 Web 控制台完成设置。",
    commandActionDescription: "使用 Web 控制台生成的启动命令。",
    credentialsTitle: "连接器凭据",
    credentialsDescription: "通常由配对或启动命令保存。",
    serverUrl: "服务器 URL",
    connectorId: "连接器 ID",
    connectorToken: "连接器 token",
    saveConfig: "保存配置",
    savedStarting: "已保存，正在启动连接器。",
    parseStartCommand: "请粘贴启动命令。",
    parseMissingValues: "这条命令缺少必要信息。",
    connectorStarted: "连接器已启动",
    connectorStopped: "连接器已停止",
    connectorRestarted: "连接器已重启",
    configSaved: "配置已保存",
    pairingStarted: "配对已开始",
  },
} as const

type DesktopMessageKey = keyof typeof desktopMessages.en
type DesktopMessages = Record<DesktopMessageKey, string>

function useDesktopMessages(): DesktopMessages {
  const [locale, setLocale] = React.useState<keyof typeof desktopMessages>("en")

  React.useEffect(() => {
    const language = navigator.language.toLowerCase()
    setLocale(language.startsWith("zh") ? "zh" : "en")
  }, [])

  return desktopMessages[locale] as DesktopMessages
}

export function DesktopShell() {
  const t = useDesktopMessages()
  const [view, setView] = React.useState<View>("overview")
  const [state, setState] = React.useState<ConnectorState | null>(null)
  const [config, setConfig] = React.useState<ConnectorConfig>(defaultConfig)
  const [logs, setLogs] = React.useState<ConnectorLog[]>([])
  const [pairing, setPairing] = React.useState<PairingState | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [bridgeError, setBridgeError] = React.useState<string | null>(null)
  const [pairOpen, setPairOpen] = React.useState(false)
  const [pairStep, setPairStep] = React.useState<PairDialogStep>("input")
  const [pairServer, setPairServer] = React.useState("")
  const [commandOpen, setCommandOpen] = React.useState(false)
  const [commandStep, setCommandStep] = React.useState<CommandDialogStep>("input")
  const [commandInput, setCommandInput] = React.useState("")
  const [parsedCommand, setParsedCommand] = React.useState<ConnectorConfig | null>(null)

  React.useEffect(() => {
    let cleanup: Array<() => void> = []
    async function boot() {
      try {
        const api = connectorDesktop()
        const [nextState, nextConfig] = await Promise.all([api.getState(), api.getConfig()])
        setState(nextState)
        setConfig({ ...defaultConfig, ...nextConfig })
        cleanup = [
          api.onState((next) => setState(next)),
          api.onPairing((next) => {
            setPairing(next)
            if (next.status === "waiting") setPairStep("waiting")
            if (next.status === "claimed") setPairStep("claimed")
            if (next.status === "error") setPairStep("error")
            if (next.config) setConfig({ ...defaultConfig, ...next.config })
          }),
          api.onLog((entry) => setLogs((current) => [...current.slice(-399), entry])),
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

  async function startConnector(runtimeConfig?: ConnectorConfig) {
    const next = await run("start", () => connectorDesktop().start(runtimeConfig), t.connectorStarted)
    if (next) setState(next)
  }

  async function stopConnector() {
    const next = await run("stop", () => connectorDesktop().stop(), t.connectorStopped)
    if (next) setState(next)
  }

  async function restartConnector() {
    const next = await run("restart", () => connectorDesktop().restart(), t.connectorRestarted)
    if (next) setState(next)
  }

  async function saveConfig(nextConfig: ConnectorConfig) {
    const saved = await run("save", () => connectorDesktop().saveConfig(nextConfig), t.configSaved)
    if (saved) setConfig({ ...defaultConfig, ...saved })
    return saved
  }

  async function startPairing() {
    const next = await run("pairing", () => connectorDesktop().startPairing({ server: pairServer }), t.pairingStarted)
    if (next) {
      setPairing(next)
      setPairStep(next.status === "waiting" ? "waiting" : "input")
    }
  }

  async function cancelPairing() {
    await run("cancelPairing", () => connectorDesktop().cancelPairing())
    setPairing(null)
    setPairStep("input")
    setPairOpen(false)
  }

  async function saveSettings(patch: DesktopSettings) {
    const next = await run("settings", () => connectorDesktop().saveSettings(patch))
    if (next) setState(next)
  }

  function openPairDialog() {
    setPairOpen(true)
    setPairStep(pairing?.code ? "waiting" : "input")
  }

  function openCommandDialog() {
    setCommandOpen(true)
    setCommandStep("input")
    setParsedCommand(null)
  }

  function parseCommand() {
    try {
      const parsed = parseConnectorCommand(commandInput, t)
      setParsedCommand(parsed)
      setCommandStep("confirm")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  async function runParsedCommand(save: boolean) {
    if (!parsedCommand) return
    if (save) await saveConfig(parsedCommand)
    await startConnector(parsedCommand)
    setCommandOpen(false)
  }

  const isRunning = Boolean(state?.running)
  const status = state?.status ?? "loading"
  const activePairing = pairing?.status || (state?.pairing ? "active" : "idle")
  const isMac = state?.platform === "darwin"

  return (
    <div className="flex h-screen min-h-0 bg-background text-foreground">
      <aside className="drag-region flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className={cn("flex px-5", isMac ? "h-20 items-end pb-4" : "h-16 items-center")}>
          <div className="min-w-0">
            <div className="aa-wordmark truncate text-xl">{t.appName}</div>
          </div>
        </div>
        <nav className="no-drag flex flex-1 flex-col gap-1 px-3 py-2 text-sm">
          <NavItem icon={Wifi} label={t.navOverview} active={view === "overview"} onClick={() => setView("overview")} />
          <NavItem icon={Terminal} label={t.navLogs} active={view === "logs"} onClick={() => setView("logs")} />
        </nav>
        <div className="no-drag border-t p-3">
          <NavItem icon={Settings2} label={t.navSettings} active={view === "settings"} onClick={() => setView("settings")} />
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="drag-region flex h-16 shrink-0 items-center justify-between border-b px-5">
          <div>
            <h1 className="text-sm font-semibold">{t.headerTitle}</h1>
            <p className="text-xs text-muted-foreground">{t.headerSubtitle}</p>
          </div>
          <div className="no-drag flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={restartConnector} disabled={Boolean(busy)}>
              <RotateCcw className="size-4" />
              {t.restart}
            </Button>
            {isRunning ? (
              <Button variant="destructive" size="sm" onClick={stopConnector} disabled={Boolean(busy)}>
                <Square className="size-4" />
                {t.stop}
              </Button>
            ) : (
              <Button size="sm" onClick={() => startConnector()} disabled={Boolean(busy) || !state?.hasConfig}>
                <Play className="size-4" />
                {t.start}
              </Button>
            )}
          </div>
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-5">
            {bridgeError ? <BridgeError t={t} message={bridgeError} /> : null}
            {view === "overview" ? (
              <Overview
                t={t}
                runtimeStatus={status}
                runtimeDetail={state?.lastError || (isRunning ? t.runtimeConnected : t.runtimeIdle)}
                pairingStatus={activePairing}
                pairingDetail={pairing?.code ? `${t.pairingCode} ${pairing.code}` : t.noPairingCode}
                onPair={openPairDialog}
                onCommand={openCommandDialog}
              />
            ) : null}
            {view === "logs" ? <LogsView t={t} logs={logs} onClear={() => setLogs([])} /> : null}
            {view === "settings" ? (
              <SettingsView
                t={t}
                state={state}
                config={config}
                setConfig={setConfig}
                saveConfig={saveConfig}
                saveSettings={saveSettings}
              />
            ) : null}
          </div>
        </ScrollArea>
      </main>

      <PairingDialog
        t={t}
        open={pairOpen}
        step={pairStep}
        server={pairServer}
        pairing={pairing}
        busy={busy}
        onServerChange={setPairServer}
        onOpenChange={setPairOpen}
        onStart={startPairing}
        onCancel={cancelPairing}
      />
      <CommandDialog
        t={t}
        open={commandOpen}
        step={commandStep}
        command={commandInput}
        parsed={parsedCommand}
        busy={busy}
        onCommandChange={setCommandInput}
        onOpenChange={setCommandOpen}
        onParse={parseCommand}
        onRun={runParsedCommand}
      />
    </div>
  )
}

function Overview({
  t,
  runtimeStatus,
  runtimeDetail,
  pairingStatus,
  pairingDetail,
  onPair,
  onCommand,
}: {
  t: DesktopMessages
  runtimeStatus: string
  runtimeDetail: string
  pairingStatus: string
  pairingDetail: string
  onPair: () => void
  onCommand: () => void
}) {
  return (
    <>
      <section className="grid gap-4 md:grid-cols-2">
        <Metric title={t.runtimeStatus} value={runtimeStatus} detail={runtimeDetail} />
        <Metric title={t.pairingStatus} value={pairingStatus} detail={pairingDetail} />
      </section>
      <section className="grid gap-4 md:grid-cols-2">
        <ActionCard
          icon={Wifi}
          title={t.startPairing}
          description={t.pairActionDescription}
          onClick={onPair}
        />
        <ActionCard
          icon={Clipboard}
          title={t.startFromCommand}
          description={t.commandActionDescription}
          onClick={onCommand}
        />
      </section>
    </>
  )
}

function SettingsView({
  t,
  state,
  config,
  setConfig,
  saveConfig,
  saveSettings,
}: {
  t: DesktopMessages
  state: ConnectorState | null
  config: ConnectorConfig
  setConfig: React.Dispatch<React.SetStateAction<ConnectorConfig>>
  saveConfig: (config: ConnectorConfig) => Promise<ConnectorConfig | null>
  saveSettings: (settings: DesktopSettings) => Promise<void>
}) {
  const [uvCommand, setUvCommand] = React.useState(state?.uvCommand || "uv")

  React.useEffect(() => {
    setUvCommand(state?.uvCommand || "uv")
  }, [state?.uvCommand])

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle>{t.settings}</CardTitle>
          <CardDescription>{t.settingsDescription}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <SettingToggle
            title={t.launchAtLogin}
            description={t.launchAtLoginHint}
            checked={Boolean(state?.openAtLogin)}
            onCheckedChange={(openAtLogin) => saveSettings({ openAtLogin })}
          />
          <SettingToggle
            title={t.startOnLaunch}
            description={t.startOnLaunchHint}
            checked={state?.startConnectorOnLaunch !== false}
            onCheckedChange={(startConnectorOnLaunch) => saveSettings({ startConnectorOnLaunch })}
          />
          <div className="grid gap-2">
            <Label htmlFor="uv-command">{t.uvCommand}</Label>
            <Input
              id="uv-command"
              value={uvCommand}
              onChange={(event) => setUvCommand(event.target.value)}
              onBlur={(event) => saveSettings({ uvCommand: event.target.value })}
            />
          </div>
          <PathRow label={t.configPath} value={state?.configPath || "-"} />
          <PathRow label={t.settingsPath} value={state?.settingsPath || "-"} />
          <div>
            <Button variant="outline" onClick={() => void connectorDesktop().openConfigFolder()}>
              <FolderOpen className="size-4" />
              {t.openConfigFolder}
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t.credentialsTitle}</CardTitle>
          <CardDescription>{t.credentialsDescription}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t.serverUrl} value={config.serverUrl} onChange={(value) => setConfig((current) => ({ ...current, serverUrl: value }))} />
            <Field label={t.connectorId} value={config.connectorId} onChange={(value) => setConfig((current) => ({ ...current, connectorId: value }))} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="token">{t.connectorToken}</Label>
            <Textarea
              id="token"
              className="min-h-24 font-mono text-xs"
              value={config.connectorToken}
              onChange={(event) => setConfig((current) => ({ ...current, connectorToken: event.target.value }))}
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={() => void saveConfig(config)}>
              <CheckCircle2 className="size-4" />
              {t.saveConfig}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function PairingDialog({
  t,
  open,
  step,
  server,
  pairing,
  busy,
  onServerChange,
  onOpenChange,
  onStart,
  onCancel,
}: {
  t: DesktopMessages
  open: boolean
  step: PairDialogStep
  server: string
  pairing: PairingState | null
  busy: string | null
  onServerChange: (value: string) => void
  onOpenChange: (open: boolean) => void
  onStart: () => Promise<void>
  onCancel: () => Promise<void>
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {step === "input" ? (
          <>
            <DialogHeader>
              <DialogTitle>{t.pairingTitle}</DialogTitle>
              <DialogDescription>{t.pairingDescription}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 py-2">
              <Label htmlFor="pair-server">{t.server}</Label>
              <Input
                id="pair-server"
                value={server}
                onChange={(event) => onServerChange(event.target.value)}
                placeholder="https://agents-anywhere.example"
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t.cancel}
              </Button>
              <Button onClick={onStart} disabled={!server.trim() || Boolean(busy)}>
                {busy === "pairing" ? <Loader2 className="size-4 animate-spin" /> : <Wifi className="size-4" />}
                {t.startPairing}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{step === "claimed" ? t.pairingComplete : t.pairingCode}</DialogTitle>
              <DialogDescription>{pairing?.serverUrl || pairing?.error || t.pairingWaiting}</DialogDescription>
            </DialogHeader>
            {pairing?.code ? <PairingCode t={t} code={pairing.code} /> : null}
            {step === "claimed" ? <SuccessNote t={t} /> : null}
            {step === "error" ? <ErrorNote message={pairing?.error || t.pairingFailed} /> : null}
            <DialogFooter>
              {step === "claimed" ? (
                <Button onClick={() => onOpenChange(false)}>{t.done}</Button>
              ) : (
                <Button variant="outline" onClick={onCancel}>
                  {t.cancel}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function CommandDialog({
  t,
  open,
  step,
  command,
  parsed,
  busy,
  onCommandChange,
  onOpenChange,
  onParse,
  onRun,
}: {
  t: DesktopMessages
  open: boolean
  step: CommandDialogStep
  command: string
  parsed: ConnectorConfig | null
  busy: string | null
  onCommandChange: (value: string) => void
  onOpenChange: (open: boolean) => void
  onParse: () => void
  onRun: (save: boolean) => Promise<void>
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.commandTitle}</DialogTitle>
          <DialogDescription>{t.commandDescription}</DialogDescription>
        </DialogHeader>
        {step === "input" ? (
          <>
            <div className="grid gap-2 py-2">
              <Label htmlFor="connector-command">{t.commandLabel}</Label>
              <Textarea
                id="connector-command"
                className="min-h-28 font-mono text-xs"
                value={command}
                onChange={(event) => onCommandChange(event.target.value)}
                placeholder="uvx anywhere-cli start --server-url ... --connector-id ... --connector-token ..."
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t.cancel}
              </Button>
              <Button onClick={onParse} disabled={!command.trim()}>
                {t.continue}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="rounded-lg border bg-muted/30 p-4 text-sm">
              <div className="font-medium">{parsed?.serverUrl}</div>
              <div className="mt-1 font-mono text-xs text-muted-foreground">{parsed?.connectorId}</div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onRun(false)} disabled={Boolean(busy)}>
                {t.runOnce}
              </Button>
              <Button onClick={() => onRun(true)} disabled={Boolean(busy)}>
                {t.saveAndStart}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function NavItem({
  icon: Icon,
  label,
  active = false,
  onClick,
}: {
  icon: React.ElementType
  label: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
      )}
      onClick={onClick}
    >
      <Icon className="size-4" />
      {label}
    </button>
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

function ActionCard({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: React.ElementType
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="group rounded-lg border bg-card p-5 text-left transition-colors hover:bg-muted/35"
      onClick={onClick}
    >
      <div className="mb-4 flex size-9 items-center justify-center rounded-md border bg-background">
        <Icon className="size-4" />
      </div>
      <div className="text-sm font-medium">{title}</div>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </button>
  )
}

function LogsView({ t, logs, onClear }: { t: DesktopMessages; logs: ConnectorLog[]; onClear: () => void }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>{t.logs}</CardTitle>
          <CardDescription>{t.logsDescription}</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={onClear}>
          {t.clear}
        </Button>
      </CardHeader>
      <CardContent>
        <LogList t={t} logs={logs} />
      </CardContent>
    </Card>
  )
}

function LogList({ t, logs }: { t: DesktopMessages; logs: ConnectorLog[] }) {
  if (logs.length === 0) {
    return <div className="flex h-72 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">{t.noLogs}</div>
  }
  return (
    <div className="h-[520px] overflow-auto rounded-lg border bg-muted/20 p-3 font-mono text-xs">
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

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = React.useId()
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  )
}

function SettingToggle({
  title,
  description,
  checked,
  onCheckedChange,
}: {
  title: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border px-3 py-2">
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

function PathRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <code className="block truncate rounded-md border bg-muted/30 px-3 py-2 text-xs">{value}</code>
    </div>
  )
}

function PairingCode({ t, code }: { t: DesktopMessages; code: string }) {
  const [copied, setCopied] = React.useState(false)
  async function copy() {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    toast.success(t.copied)
    window.setTimeout(() => setCopied(false), 1400)
  }
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 p-4">
      <div className="font-mono text-3xl font-semibold tracking-[0.35em]">{code}</div>
      <Button variant="outline" size="icon" onClick={copy}>
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
    </div>
  )
}

function SuccessNote({ t }: { t: DesktopMessages }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
      <CheckCircle2 className="size-4 text-emerald-500" />
      {t.savedStarting}
    </div>
  )
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      <CircleAlert className="size-4" />
      {message}
    </div>
  )
}

function BridgeError({ t, message }: { t: DesktopMessages; message: string }) {
  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle>{t.bridgeUnavailable}</CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
    </Card>
  )
}

function parseConnectorCommand(input: string, t: DesktopMessages): ConnectorConfig {
  const parts = splitShell(input.trim())
  const commandIndex = parts.findIndex((part) => part === "start")
  if (commandIndex < 0) throw new Error(t.parseStartCommand)
  const arg = (name: string) => {
    const index = parts.indexOf(name)
    return index >= 0 ? parts[index + 1] : undefined
  }
  const serverUrl = arg("--server-url")?.replace(/\/+$/, "") || ""
  const connectorId = arg("--connector-id") || ""
  const connectorToken = arg("--connector-token") || ""
  if (!serverUrl || !connectorId || !connectorToken) {
    throw new Error(t.parseMissingValues)
  }
  return {
    ...defaultConfig,
    serverUrl,
    connectorId,
    connectorToken,
  }
}

function splitShell(input: string): string[] {
  const parts: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? ""
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (current) parts.push(current)
  return parts
}
