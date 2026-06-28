"use client"

import * as React from "react"
import {
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clipboard,
  Copy,
  FolderOpen,
  Gauge,
  Globe2,
  KeyRound,
  Loader2,
  Logs,
  Pause,
  Plus,
  Play,
  RefreshCw,
  RotateCcw,
  Settings,
  Square,
  Trash2,
  Languages,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import { Toggle } from "@/components/ui/toggle"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldTitle } from "@/components/ui/field"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
type ParsedConnectorCommand =
  | { kind: "start"; config: ConnectorConfig }
  | { kind: "pair"; server: string }
const LOG_PAGE_SIZE = 120

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
    pairingStatus: "Credential",
    start: "Start",
    stop: "Stop",
    restart: "Restart",
    startPairing: "Start pairing",
    startFromCommand: "Start from command",
    logs: "Logs",
    logsDescription: "Recent connector activity.",
    liveLogs: "Live",
    pausedLogs: "Paused",
    refresh: "Refresh",
    loadMore: "Load more",
    logStorageTitle: "Logs",
    logChunkSize: "Chunk size",
    logRetainChunks: "Retained chunks",
    logRetentionDays: "Retention days",
    clear: "Clear",
    settings: "Settings",
    settingsDescription: "Startup and local connector options.",
    startupTitle: "Startup",
    appearanceTitle: "Appearance",
    localFilesTitle: "Local files",
    credentialsSectionTitle: "Credentials",
    launchAtLogin: "Open at login",
    launchAtLoginHint: "Open the desktop app when you sign in.",
    startOnLaunch: "Start connector on launch",
    startOnLaunchHint: "Start automatically when credentials are saved.",
    language: "Language",
    languageDescription: "Choose the interface language for this desktop app.",
    systemLanguage: "System",
    english: "English",
    simplifiedChinese: "Simplified Chinese",
    uvPath: "uv path",
    configPath: "Config path",
    settingsPath: "Settings path",
    logPath: "Log path",
    openConfigFolder: "Open config folder",
    pairingTitle: "Pair this machine",
    pairingDescription: "Enter your server address to get a pairing code.",
    pairingComplete: "Pairing complete",
    pairingCode: "Pairing code",
    pairingWaiting: "Waiting for claim in the web console.",
    pairingFailed: "Pairing failed",
    server: "Server",
    commandTitle: "Start from command",
    commandDescription: "Paste the command from the web console.",
    commandLabel: "Connector command",
    pairCommandReady: "This command starts pairing.",
    startCommandReady: "This command contains connector credentials.",
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
    runtimeError: "Error",
    credentialExpired: "Credential expired",
    fixCredential: "Pair again or paste a new start command.",
    credentialExpiredToast: "Credential expired. Pair again or paste a new start command.",
    credentialPaired: "Paired",
    credentialOneTime: "Using one-time credential",
    credentialMissing: "Not paired",
    credentialReadyDetail: "Saved credentials are ready.",
    credentialOneTimeDetail: "This run uses pasted credentials.",
    credentialMissingDetail: "Pair this machine or paste a start command.",
    pairActionDescription: "Get a code and finish setup in the web console.",
    commandActionDescription: "Use the start command generated in the web console.",
    credentialsTitle: "Connector credentials",
    credentialsDescription: "Saved by pairing or command setup.",
    serverUrl: "Server URL",
    connectorId: "Connector ID",
    connectorToken: "Connector token",
    saveConfig: "Save config",
    savedStarting: "Saved. Starting connector.",
    parseStartCommand: "Paste a start or pair command.",
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
    pairingStatus: "凭据",
    start: "启动",
    stop: "停止",
    restart: "重启",
    startPairing: "开始配对",
    startFromCommand: "从命令启动",
    logs: "日志",
    logsDescription: "最近的连接器活动。",
    liveLogs: "实时",
    pausedLogs: "暂停",
    refresh: "刷新",
    loadMore: "加载更多",
    logStorageTitle: "日志",
    logChunkSize: "分块大小",
    logRetainChunks: "保留分块",
    logRetentionDays: "保留天数",
    clear: "清空",
    settings: "设置",
    settingsDescription: "启动项和本机连接器选项。",
    startupTitle: "启动",
    appearanceTitle: "外观",
    localFilesTitle: "本机文件",
    credentialsSectionTitle: "凭据",
    launchAtLogin: "登录时打开",
    launchAtLoginHint: "登录系统后打开桌面应用。",
    startOnLaunch: "打开应用后启动连接器",
    startOnLaunchHint: "已保存凭据时自动启动。",
    language: "语言",
    languageDescription: "选择此桌面应用的界面语言。",
    systemLanguage: "跟随系统",
    english: "English",
    simplifiedChinese: "简体中文",
    uvPath: "uv 路径",
    configPath: "配置路径",
    settingsPath: "设置路径",
    logPath: "日志路径",
    openConfigFolder: "打开配置文件夹",
    pairingTitle: "配对这台电脑",
    pairingDescription: "输入服务器地址，生成配对码。",
    pairingComplete: "配对完成",
    pairingCode: "配对码",
    pairingWaiting: "等待在 Web 控制台认领。",
    pairingFailed: "配对失败",
    server: "服务器",
    commandTitle: "从命令启动",
    commandDescription: "粘贴 Web 控制台生成的命令。",
    commandLabel: "连接器命令",
    pairCommandReady: "这条命令会开始配对。",
    startCommandReady: "这条命令包含连接器凭据。",
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
    runtimeError: "错误",
    credentialExpired: "凭据已失效",
    fixCredential: "重新配对，或粘贴新的启动命令。",
    credentialExpiredToast: "凭据已失效。请重新配对，或粘贴新的启动命令。",
    credentialPaired: "已配对",
    credentialOneTime: "正在使用一次性凭据",
    credentialMissing: "未配对",
    credentialReadyDetail: "已保存凭据。",
    credentialOneTimeDetail: "本次运行使用粘贴的凭据。",
    credentialMissingDetail: "配对这台电脑，或粘贴启动命令。",
    pairActionDescription: "生成配对码，然后在 Web 控制台完成设置。",
    commandActionDescription: "使用 Web 控制台生成的启动命令。",
    credentialsTitle: "连接器凭据",
    credentialsDescription: "通常由配对或启动命令保存。",
    serverUrl: "服务器 URL",
    connectorId: "连接器 ID",
    connectorToken: "连接器 token",
    saveConfig: "保存配置",
    savedStarting: "已保存，正在启动连接器。",
    parseStartCommand: "请粘贴启动或配对命令。",
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

function useDesktopMessages(preferredLocale: string | undefined): DesktopMessages {
  const [locale, setLocale] = React.useState<keyof typeof desktopMessages>("en")

  React.useEffect(() => {
    if (preferredLocale === "en" || preferredLocale === "zh") {
      setLocale(preferredLocale)
      return
    }
    const language = navigator.language.toLowerCase()
    setLocale(language.startsWith("zh") ? "zh" : "en")
  }, [preferredLocale])

  return desktopMessages[locale] as DesktopMessages
}

type MetricTone = "default" | "success" | "error"

function connectorStatusView(state: ConnectorState | null, isRunning: boolean, t: DesktopMessages): { value: string; detail: string; tone: MetricTone } {
  if (state?.lastError && !state.authFailed) {
    return { value: t.runtimeError, detail: state.lastError, tone: "error" }
  }
  if (isRunning) {
    return { value: t.runtimeConnected, detail: t.runtimeConnected, tone: "success" }
  }
  return { value: t.runtimeIdle, detail: t.runtimeIdle, tone: "default" }
}

function credentialStatusView(
  state: ConnectorState | null,
  config: ConnectorConfig,
  isRunning: boolean,
  t: DesktopMessages,
): { value: string; detail: string; tone: MetricTone } {
  if (state?.authFailed) {
    return { value: t.credentialExpired, detail: t.fixCredential, tone: "error" }
  }
  if (isRunning && state?.usingTemporaryCredential) {
    return { value: t.credentialOneTime, detail: t.credentialOneTimeDetail, tone: "success" }
  }
  if (state?.hasConfig || Boolean(config.connectorId && config.connectorToken)) {
    return { value: t.credentialPaired, detail: t.credentialReadyDetail, tone: "success" }
  }
  return { value: t.credentialMissing, detail: t.credentialMissingDetail, tone: "default" }
}

export function DesktopShell() {
  const [state, setState] = React.useState<ConnectorState | null>(null)
  const [localeOverride, setLocaleOverride] = React.useState<"system" | "en" | "zh" | null>(null)
  const effectiveLocale = localeOverride ?? state?.locale
  const t = useDesktopMessages(effectiveLocale)
  const [view, setView] = React.useState<View>("overview")
  const [config, setConfig] = React.useState<ConnectorConfig>(defaultConfig)
  const [logs, setLogs] = React.useState<ConnectorLog[]>([])
  const [logCursor, setLogCursor] = React.useState<number | null>(null)
  const [logTotal, setLogTotal] = React.useState(0)
  const [liveLogs, setLiveLogs] = React.useState(true)
  const [pairing, setPairing] = React.useState<PairingState | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [bridgeError, setBridgeError] = React.useState<string | null>(null)
  const [pairOpen, setPairOpen] = React.useState(false)
  const [pairStep, setPairStep] = React.useState<PairDialogStep>("input")
  const [pairServer, setPairServer] = React.useState("")
  const [commandOpen, setCommandOpen] = React.useState(false)
  const [commandStep, setCommandStep] = React.useState<CommandDialogStep>("input")
  const [commandInput, setCommandInput] = React.useState("")
  const [parsedCommand, setParsedCommand] = React.useState<ParsedConnectorCommand | null>(null)
  const authFailedToastShown = React.useRef(false)
  const liveLogsRef = React.useRef(liveLogs)

  React.useEffect(() => {
    let cleanup: Array<() => void> = []
    async function boot() {
      try {
        const api = connectorDesktop()
        const [nextState, nextConfig] = await Promise.all([api.getState(), api.getConfig()])
        setState(nextState)
        setConfig({ ...defaultConfig, ...nextConfig })
        void loadLogs({ reset: true })
        cleanup = [
          api.onState((next) => setState(next)),
          api.onPairing((next) => {
            setPairing(next)
            if (next.status === "waiting") setPairStep("waiting")
            if (next.status === "claimed") setPairStep("claimed")
            if (next.status === "error") setPairStep("error")
            if (next.config) setConfig({ ...defaultConfig, ...next.config })
          }),
          api.onLog((entry) => {
            if (!liveLogsRef.current) return
            setLogs((current) => [entry, ...current].slice(0, LOG_PAGE_SIZE))
            setLogTotal((current) => current + 1)
          }),
          api.onLogsCleared(() => {
            setLogs([])
            setLogCursor(null)
            setLogTotal(0)
          }),
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

  React.useEffect(() => {
    liveLogsRef.current = liveLogs
  }, [liveLogs])

  React.useEffect(() => {
    if (state?.authFailed) {
      if (!authFailedToastShown.current) {
        toast.error(t.credentialExpiredToast)
        authFailedToastShown.current = true
      }
      return
    }
    authFailedToastShown.current = false
  }, [state?.authFailed, t.credentialExpiredToast])

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

  async function loadLogs(options: { reset?: boolean } = {}) {
    const cursor = options.reset ? null : logCursor
    const page = await run("logs", () => connectorDesktop().getLogs({ cursor, pageSize: LOG_PAGE_SIZE, newestFirst: true }))
    if (!page) return
    setLogs((current) => (options.reset ? page.items : [...current, ...page.items]))
    setLogCursor(page.nextCursor)
    setLogTotal(page.total)
  }

  async function clearLogs() {
    const page = await run("clearLogs", () => connectorDesktop().clearLogs())
    if (!page) return
    setLogs(page.items)
    setLogCursor(page.nextCursor)
    setLogTotal(page.total)
  }

  async function startPairing() {
    let server = pairServer
    try {
      const parsed = parseConnectorCommand(pairServer, t)
      if (parsed.kind === "start") {
        setParsedCommand(parsed)
        setPairOpen(false)
        setCommandOpen(true)
        setCommandStep("confirm")
        return
      }
      server = parsed.server
      setPairServer(server)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return
    }
    const next = await run("pairing", () => connectorDesktop().startPairing({ server }), t.pairingStarted)
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

  function saveLocale(locale: "system" | "en" | "zh") {
    setLocaleOverride(locale)
    void saveSettings({ locale })
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
    if (parsedCommand.kind === "pair") {
      setCommandOpen(false)
      setPairOpen(true)
      setPairStep("input")
      setPairServer(parsedCommand.server)
      const next = await run("pairing", () => connectorDesktop().startPairing({ server: parsedCommand.server }), t.pairingStarted)
      if (next) {
        setPairing(next)
        setPairStep(next.status === "waiting" ? "waiting" : "input")
      }
      return
    }
    if (save) {
      const saved = await saveConfig(parsedCommand.config)
      if (saved) await startConnector()
    } else {
      await startConnector(parsedCommand.config)
    }
    setCommandOpen(false)
  }

  const isRunning = Boolean(state?.running)
  const connectorView = connectorStatusView(state, isRunning, t)
  const credentialView = credentialStatusView(state, config, isRunning, t)
  const isMac = state?.platform === "darwin"
  const pageTitle = view === "logs" ? t.logs : view === "settings" ? t.settings : t.headerTitle
  const pageDescription = view === "logs" ? t.logsDescription : view === "settings" ? t.settingsDescription : ""

  return (
    <div className="flex h-screen min-h-0 bg-background text-foreground">
      <aside className="drag-region flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className={cn("flex px-5", isMac ? "h-20 items-end pb-4" : "h-16 items-center")}>
          <div className="min-w-0">
            <div className="aa-wordmark text-xl">{t.appName}</div>
          </div>
        </div>
        <nav className="no-drag flex flex-1 flex-col gap-1 px-3 py-2 text-sm">
          <NavItem icon={Gauge} label={t.navOverview} active={view === "overview"} onClick={() => setView("overview")} />
          <NavItem icon={Logs} label={t.navLogs} active={view === "logs"} onClick={() => setView("logs")} />
        </nav>
        <div className="no-drag p-3">
          <NavItem icon={Settings} label={t.navSettings} active={view === "settings"} onClick={() => setView("settings")} />
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="drag-region flex h-16 shrink-0 items-center justify-between border-b px-5">
          <div>
            <h1 className="text-lg font-semibold">{pageTitle}</h1>
            {pageDescription ? <p className="text-xs text-muted-foreground">{pageDescription}</p> : null}
          </div>
          <div className="no-drag flex items-center gap-2">
            {view === "logs" ? (
              <>
                <Toggle
                  pressed={liveLogs}
                  onPressedChange={setLiveLogs}
                  variant="outline"
                  size="sm"
                  aria-label={t.liveLogs}
                >
                  {liveLogs ? <RefreshCw className="size-4" /> : <Pause className="size-4" />}
                  {liveLogs ? t.liveLogs : t.pausedLogs}
                </Toggle>
                <Button variant="outline" size="sm" onClick={() => void loadLogs({ reset: true })} disabled={Boolean(busy)}>
                  <RefreshCw className="size-4" />
                  {t.refresh}
                </Button>
                <Button variant="outline" size="sm" onClick={() => void clearLogs()} disabled={Boolean(busy)}>
                  <Trash2 className="size-4" />
                  {t.clear}
                </Button>
              </>
            ) : (
              <>
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
              </>
            )}
          </div>
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <div className={cn("mx-auto flex w-full flex-col", view === "logs" ? "max-w-none" : "max-w-5xl gap-5 p-5")}>
            {bridgeError ? <BridgeError t={t} message={bridgeError} /> : null}
            {view === "overview" ? (
              <Overview
                t={t}
                runtimeStatus={connectorView.value}
                runtimeDetail={connectorView.detail}
                runtimeTone={connectorView.tone}
                pairingStatus={credentialView.value}
                pairingDetail={credentialView.detail}
                pairingTone={credentialView.tone}
                onPair={openPairDialog}
                onCommand={openCommandDialog}
              />
            ) : null}
            {view === "logs" ? (
              <LogsView
                t={t}
                logs={logs}
                total={logTotal}
                hasMore={logCursor != null}
                onLoadMore={() => void loadLogs()}
              />
            ) : null}
            {view === "settings" ? (
              <SettingsView
                t={t}
                state={state}
                config={config}
                locale={effectiveLocale}
                setConfig={setConfig}
                saveConfig={saveConfig}
                saveSettings={saveSettings}
                saveLocale={saveLocale}
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
  runtimeTone,
  pairingStatus,
  pairingDetail,
  pairingTone,
  onPair,
  onCommand,
}: {
  t: DesktopMessages
  runtimeStatus: string
  runtimeDetail: string
  runtimeTone: "default" | "success" | "error"
  pairingStatus: string
  pairingDetail: string
  pairingTone: "default" | "success" | "error"
  onPair: () => void
  onCommand: () => void
}) {
  return (
    <>
      <section className="grid gap-4 md:grid-cols-2">
        <Metric title={t.runtimeStatus} value={runtimeStatus} detail={runtimeDetail} tone={runtimeTone} />
        <Metric title={t.pairingStatus} value={pairingStatus} detail={pairingDetail} tone={pairingTone} />
      </section>
      <section className="mt-3 grid gap-3 border-t pt-5">
        <ActionCard
          icon={Plus}
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
  locale,
  setConfig,
  saveConfig,
  saveSettings,
  saveLocale,
}: {
  t: DesktopMessages
  state: ConnectorState | null
  config: ConnectorConfig
  locale: string | undefined
  setConfig: React.Dispatch<React.SetStateAction<ConnectorConfig>>
  saveConfig: (config: ConnectorConfig) => Promise<ConnectorConfig | null>
  saveSettings: (settings: DesktopSettings) => Promise<void>
  saveLocale: (locale: "system" | "en" | "zh") => void
}) {
  const [uvPath, setUvPath] = React.useState(state?.uvPath || "")

  React.useEffect(() => {
    setUvPath(state?.uvPath || "")
  }, [state?.uvPath])

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t.startupTitle}</CardTitle>
          <CardDescription>{t.settingsDescription}</CardDescription>
          <CardAction>
            <Settings className="size-5" />
          </CardAction>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <SettingSwitchField
              label={t.launchAtLogin}
              description={t.launchAtLoginHint}
              checked={Boolean(state?.openAtLogin)}
              onCheckedChange={(openAtLogin) => saveSettings({ openAtLogin })}
            />
            <SettingSwitchField
              label={t.startOnLaunch}
              description={t.startOnLaunchHint}
              checked={state?.startConnectorOnLaunch !== false}
              onCheckedChange={(startConnectorOnLaunch) => saveSettings({ startConnectorOnLaunch })}
            />
            <SettingInputField
              label={t.uvPath}
              value={uvPath}
              onChange={setUvPath}
              onBlur={(value) => saveSettings({ uvPath: value })}
            />
          </FieldGroup>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t.logStorageTitle}</CardTitle>
          <CardDescription>{t.logsDescription}</CardDescription>
          <CardAction>
            <Logs className="size-5" />
          </CardAction>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <SettingNumberField
              label={t.logChunkSize}
              value={String(state?.logChunkSizeKb ?? 512)}
              onBlur={(value) => saveSettings({ logChunkSizeKb: Number(value) })}
            />
            <SettingNumberField
              label={t.logRetainChunks}
              value={String(state?.logRetainChunks ?? 20)}
              onBlur={(value) => saveSettings({ logRetainChunks: Number(value) })}
            />
            <SettingNumberField
              label={t.logRetentionDays}
              value={String(state?.logRetentionDays ?? 14)}
              onBlur={(value) => saveSettings({ logRetentionDays: Number(value) })}
            />
          </FieldGroup>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t.appearanceTitle}</CardTitle>
          <CardAction>
            <Languages className="size-5" />
          </CardAction>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <LanguageField
              t={t}
              value={(locale === "en" || locale === "zh" || locale === "system") ? locale : "system"}
              onValueChange={saveLocale}
            />
          </FieldGroup>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t.localFilesTitle}</CardTitle>
          <CardAction>
            <FolderOpen className="size-5" />
          </CardAction>
        </CardHeader>
        <CardContent className="px-0">
          <FieldGroup>
            <InfoRow label={t.configPath} value={<ScrollableCode value={state?.configPath || "-"} />} />
            <InfoRow label={t.settingsPath} value={<ScrollableCode value={state?.settingsPath || "-"} />} />
            <InfoRow label={t.logPath} value={<ScrollableCode value={state?.logPath || "-"} />} />
            <SettingActionField
              label={t.openConfigFolder}
              last
              action={
                <Button variant="outline" size="sm" onClick={() => void connectorDesktop().openConfigFolder()}>
                  <FolderOpen className="size-4" />
                  {t.openConfigFolder}
                </Button>
              }
            />
          </FieldGroup>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t.credentialsSectionTitle}</CardTitle>
          <CardDescription>{t.credentialsDescription}</CardDescription>
          <CardAction>
            <KeyRound className="size-5" />
          </CardAction>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <SettingInputField
              label={t.serverUrl}
              value={config.serverUrl}
              onChange={(value) => setConfig((current) => ({ ...current, serverUrl: value }))}
            />
            <SettingInputField
              label={t.connectorId}
              value={config.connectorId}
              onChange={(value) => setConfig((current) => ({ ...current, connectorId: value }))}
            />
            <SettingTextAreaField
              label={t.connectorToken}
              value={config.connectorToken}
              onChange={(value) => setConfig((current) => ({ ...current, connectorToken: value }))}
              maskWhenBlurred
            />
            <div className="flex justify-end">
              <Button onClick={() => void saveConfig(config)}>
                <CheckCircle2 className="size-4" />
                {t.saveConfig}
              </Button>
            </div>
          </FieldGroup>
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
                placeholder="uvx anywhere-cli pair https://example.com"
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t.cancel}
              </Button>
              <Button onClick={onStart} disabled={!server.trim() || Boolean(busy)}>
                {busy === "pairing" ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
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
  parsed: ParsedConnectorCommand | null
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
              <div className="font-medium">{parsed?.kind === "pair" ? t.pairCommandReady : t.startCommandReady}</div>
              <div className="mt-2 font-mono text-xs text-muted-foreground">
                {parsed?.kind === "pair" ? parsed.server : parsed?.config.serverUrl}
              </div>
              {parsed?.kind === "start" ? (
                <div className="mt-1 font-mono text-xs text-muted-foreground">{parsed.config.connectorId}</div>
              ) : null}
            </div>
            <DialogFooter>
              {parsed?.kind === "pair" ? (
                <Button onClick={() => onRun(false)} disabled={Boolean(busy)}>
                  {busy === "pairing" ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  {t.startPairing}
                </Button>
              ) : (
                <>
                  <Button variant="outline" onClick={() => onRun(false)} disabled={Boolean(busy)}>
                    {t.runOnce}
                  </Button>
                  <Button onClick={() => onRun(true)} disabled={Boolean(busy)}>
                    {t.saveAndStart}
                  </Button>
                </>
              )}
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

function Metric({
  title,
  value,
  detail,
  tone = "default",
}: {
  title: string
  value: string
  detail: string
  tone?: "default" | "success" | "error"
}) {
  return (
    <Card className={cn(tone === "error" && "border-destructive/50", tone === "success" && "border-emerald-500/30")}>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
        <CardTitle className={cn("text-xl", tone === "error" && "text-destructive")}>{value}</CardTitle>
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

function LogsView({
  t,
  logs,
  total,
  hasMore,
  onLoadMore,
}: {
  t: DesktopMessages
  logs: ConnectorLog[]
  total: number
  hasMore: boolean
  onLoadMore: () => void
}) {
  if (logs.length === 0) {
    return <div className="flex h-[calc(100vh-4rem)] items-center justify-center text-sm text-muted-foreground">{t.noLogs}</div>
  }
  return (
    <div className="flex h-[calc(100vh-4rem)] min-h-0 flex-col">
      <div className="border-b px-5 py-2 text-xs text-muted-foreground">
        {logs.length} / {total}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-5 py-3 font-mono text-xs">
          {logs.map((log, index) => (
            <div key={`${log.time || index}-${index}`} className="grid grid-cols-[88px_72px_1fr] gap-2 py-0.5">
              <span className="text-muted-foreground">{log.time ? new Date(log.time).toLocaleTimeString() : "--:--:--"}</span>
              <span className={cn("text-muted-foreground", log.level === "ERROR" && "text-destructive", log.level === "WARNING" && "text-yellow-600")}>{log.level || "INFO"}</span>
              <span className="min-w-0 break-words">{logMessage(log)}</span>
            </div>
          ))}
        </div>
      </ScrollArea>
      {hasMore ? (
        <div className="flex justify-center border-t p-2">
          <Button variant="outline" size="sm" onClick={onLoadMore}>
            {t.loadMore}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function InfoRow({
  label,
  value,
  action,
  last = false,
}: {
  label: string
  value: React.ReactNode
  action?: React.ReactNode
  last?: boolean
}) {
  return (
    <div className={cn("flex items-center gap-4 px-5 py-3", !last && "border-b border-border")}>
      <div className="w-32 shrink-0 text-sm text-muted-foreground">{label}</div>
      <div className="min-w-0 flex-1 text-sm">{value}</div>
      {action}
    </div>
  )
}

function ScrollableCode({ value }: { value: string }) {
  return (
    <ScrollArea className="w-full" contentWide horizontal>
      <code className="code-mono block whitespace-nowrap pb-2 text-sm">{value}</code>
    </ScrollArea>
  )
}

function SettingActionField({ label, action, last = false }: { label: string; action: React.ReactNode; last?: boolean }) {
  return <InfoRow label={label} value={<span />} action={action} last={last} />
}

function LanguageField({
  t,
  value,
  onValueChange,
}: {
  t: DesktopMessages
  value: "system" | "en" | "zh"
  onValueChange: (value: "system" | "en" | "zh") => void
}) {
  const languages: Array<{ id: "system" | "en" | "zh"; label: string }> = [
    { id: "system", label: t.systemLanguage },
    { id: "en", label: t.english },
    { id: "zh", label: t.simplifiedChinese },
  ]
  const currentLabel = languages.find((language) => language.id === value)?.label ?? t.systemLanguage

  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldTitle>{t.language}</FieldTitle>
        <FieldDescription>{t.languageDescription}</FieldDescription>
      </FieldContent>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" className="min-w-40 justify-between">
            <Globe2 data-icon="inline-start" />
            {currentLabel}
            <ChevronDown data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuRadioGroup value={value} onValueChange={(next) => onValueChange(next as "system" | "en" | "zh")}>
            {languages.map((language) => (
              <DropdownMenuRadioItem key={language.id} value={language.id}>
                {language.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </Field>
  )
}

function SettingInputField({
  label,
  value,
  onChange,
  onBlur,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  onBlur?: (value: string) => void
}) {
  const id = React.useId()
  return (
    <Field>
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} onBlur={(event) => onBlur?.(event.target.value)} />
    </Field>
  )
}

function SettingNumberField({
  label,
  value,
  onBlur,
}: {
  label: string
  value: string
  onBlur: (value: string) => void
}) {
  const id = React.useId()
  const [draft, setDraft] = React.useState(value)

  React.useEffect(() => {
    setDraft(value)
  }, [value])

  return (
    <Field>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => onBlur(event.target.value)}
      />
    </Field>
  )
}

function SettingTextAreaField({ label, value, onChange, maskWhenBlurred = false }: { label: string; value: string; onChange: (value: string) => void; maskWhenBlurred?: boolean }) {
  const id = React.useId()
  const [focused, setFocused] = React.useState(false)
  const displayValue = maskWhenBlurred && !focused && value ? "•".repeat(Math.min(Math.max(value.length, 12), 48)) : value
  return (
    <Field>
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        className="min-h-24 font-mono text-xs"
        value={displayValue}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => onChange(event.target.value)}
        readOnly={maskWhenBlurred && !focused}
      />
    </Field>
  )
}

function SettingSwitchField({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldTitle>{label}</FieldTitle>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </Field>
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

function parseConnectorCommand(input: string, t: DesktopMessages): ParsedConnectorCommand {
  const text = input.trim()
  if (!text) throw new Error(t.parseStartCommand)
  const parts = splitShell(text)
  const commandIndex = parts.findIndex((part) => part === "start" || part === "pair" || part === "login")
  if (commandIndex < 0) return { kind: "pair", server: text }
  const command = parts[commandIndex]
  const arg = (name: string) => {
    const index = parts.indexOf(name)
    return index >= 0 ? parts[index + 1] : undefined
  }
  if (command !== "start") {
    const server = arg("--server-url") || parts[commandIndex + 1] || ""
    if (!server) throw new Error(t.parseMissingValues)
    return { kind: "pair", server }
  }
  const serverUrl = arg("--server-url")?.replace(/\/+$/, "") || ""
  const connectorId = arg("--connector-id") || ""
  const connectorToken = arg("--connector-token") || ""
  if (!serverUrl || !connectorId || !connectorToken) {
    throw new Error(t.parseMissingValues)
  }
  return {
    kind: "start",
    config: {
      ...defaultConfig,
      serverUrl,
      connectorId,
      connectorToken,
    },
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
