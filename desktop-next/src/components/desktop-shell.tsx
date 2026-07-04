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
  ExternalLink,
  KeyRound,
  Loader2,
  Logs,
  Monitor,
  Pause,
  Plus,
  Play,
  RefreshCw,
  RotateCcw,
  Settings,
  Square,
  Trash2,
  Languages,
  Moon,
  Sun,
} from "lucide-react"
import { useTheme } from "next-themes"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
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
  | { kind: "start"; config: ConnectorConfig; source?: "command" | "payload" }
  | { kind: "pair"; server: string }
type ExternalLaunchCommand = ParsedConnectorCommand & { rawUrl: string }
type PendingCredentialAction =
  | { kind: "start"; config: ConnectorConfig; source: "command" | "external" }
  | { kind: "save"; config: ConnectorConfig; restart: boolean; source: "settings" }
  | { kind: "pair"; server: string; source: "manual" | "command" | "external" }
const LOG_PAGE_SIZE_OPTIONS = [100, 300, 1000, 3000] as const
const SYNC_INTERVAL_OPTIONS = [15, 30, 60, 300] as const
type AppearanceMode = "system" | "light" | "dark"
type AppearanceOption = {
  id: AppearanceMode
  messageKey: "systemTheme" | "lightTheme" | "darkTheme"
  icon: React.ComponentType<{ className?: string; "data-icon"?: string }>
}
type PypiMirrorOption = {
  id: string
  url: string
}
const APPEARANCE_OPTIONS: [AppearanceOption, AppearanceOption, AppearanceOption] = [
  { id: "system", messageKey: "systemTheme", icon: Monitor },
  { id: "light", messageKey: "lightTheme", icon: Sun },
  { id: "dark", messageKey: "darkTheme", icon: Moon },
]
const PYPI_MIRROR_OPTIONS: readonly PypiMirrorOption[] = [
  { id: "default", url: "" },
  { id: "tsinghua", url: "https://pypi.tuna.tsinghua.edu.cn/simple" },
  { id: "ustc", url: "https://mirrors.ustc.edu.cn/pypi/simple" },
  { id: "bfsu", url: "https://mirrors.bfsu.edu.cn/pypi/web/simple" },
  { id: "aliyun", url: "https://mirrors.aliyun.com/pypi/simple" },
  { id: "tencent", url: "https://mirrors.cloud.tencent.com/pypi/simple" },
  { id: "huawei", url: "https://repo.huaweicloud.com/repository/pypi/simple" },
]

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
    openAgentsAnywhere: "Open Agents Anywhere",
    headerTitle: "Desktop Connector",
    headerSubtitle: "Connect this computer to Agents Anywhere.",
    runtimeStatus: "Connector",
    pairingStatus: "Credential",
    start: "Start",
    stop: "Stop",
    restart: "Restart",
    startPairing: "Start pairing",
    startFromCommand: "Paste credentials",
    logs: "Logs",
    logsDescription: "Recent connector activity.",
    liveLogs: "Live",
    pausedLogs: "Paused",
    refresh: "Refresh",
    refreshed: "Refreshed",
    loadMore: "Load earlier logs",
    logRows: "Rows",
    logStorageTitle: "Logs",
    logChunkSize: "Chunk size",
    logRetainChunks: "Retained chunks",
    logRetentionDays: "Retention days",
    clear: "Clear",
    settings: "Settings",
    settingsDescription: "Startup and local connector options.",
    startupTitle: "Startup",
    appearanceTitle: "Appearance",
    theme: "Theme",
    themeDescription: "Choose the color theme for this desktop app.",
    systemTheme: "System",
    lightTheme: "Light",
    darkTheme: "Dark",
    localFilesTitle: "Local files",
    credentialsSectionTitle: "Credentials",
    syncSectionTitle: "Sync",
    launchAtLogin: "Open at login",
    launchAtLoginHint: "Open the desktop app when you sign in.",
    silentLaunch: "Silent login launch",
    silentLaunchHint: "When opened at login, keep the window hidden until you open it from the tray or launch the app again.",
    startOnLaunch: "Start connector on launch",
    startOnLaunchHint: "Start automatically when credentials are saved.",
    language: "Language",
    languageDescription: "Choose the interface language for this desktop app.",
    systemLanguage: "System",
    english: "English",
    simplifiedChinese: "Simplified Chinese",
    uvPath: "uv path",
    uvResolvedPath: "Resolved uv",
    uvResolvedMissing: "Not found",
    uvMissingTitle: "uv is required",
    uvMissingDescription: "The desktop connector needs uv to run the local Python connector. Install uv, then restart the desktop app or set the uv path in Settings.",
    installUv: "Install uv",
    uvPypiMirror: "uv PyPI mirror",
    uvPypiMirrorDescription: "Used when uv installs or syncs Python packages.",
    pypiDefault: "Default",
    pypiTsinghua: "Tsinghua",
    pypiUstc: "USTC",
    pypiBfsu: "BFSU",
    pypiAliyun: "Aliyun",
    pypiTencent: "Tencent Cloud",
    pypiHuawei: "Huawei Cloud",
    configPath: "Config path",
    settingsPath: "Settings path",
    logPath: "Log path",
    openConfigFolder: "Open config folder",
    pairingTitle: "Pair this machine",
    pairingDescription: "Enter a server address or paste a pairing request.",
    pairingComplete: "Pairing complete",
    pairingCode: "Pairing code",
    pairingWaiting: "Waiting for claim in the web console.",
    pairingFailed: "Pairing failed",
    server: "Server",
    commandTitle: "Paste connector credentials",
    commandDescription: "Paste credential text generated by the web console.",
    externalLaunchPairTitle: "Use pairing request?",
    externalLaunchStartTitle: "Use connector credentials?",
    externalLaunchPairDescription: "A web page is asking this desktop app to start pairing with this server.",
    externalLaunchStartDescription: "A web page is asking this desktop app to save connector credentials and start the connector.",
    externalLaunchOverwriteTitle: "Saved credentials will be replaced",
    externalLaunchOverwriteDescription: "This computer already has saved connector credentials. Continuing will replace them after the request succeeds.",
    externalLaunchConfirmPair: "Use pairing request",
    externalLaunchConfirmStart: "Save and start",
    externalLaunchInvalid: "Unsupported desktop launch link.",
    commandLabel: "Credential text",
    pairCommandReady: "Pairing request ready.",
    startCommandReady: "Connector credentials ready.",
    credentialsPayloadReady: "This credential text can be saved by the desktop connector.",
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
    setupRequired: "Setup required",
    configMissingDetail: "Pair this machine or paste credential text before starting the connector.",
    configInvalidDetail: "The saved connector config is invalid. Clear local credentials, then pair this machine again.",
    connectorSourceMissingDetail: "The bundled connector files are missing or incomplete. Reinstall the desktop app.",
    uvMissingDetail: "Install uv or set a valid uv path in Settings.",
    rpcUnavailableDetail: "The connector runtime is unavailable. Check uv, the PyPI mirror, and recent logs.",
    credentialExpired: "Credential expired",
    fixCredential: "Pair again or paste new credential text.",
    credentialExpiredToast: "Credential expired. Pair again or paste new credential text.",
    credentialPaired: "Paired",
    credentialOneTime: "Using one-time credential",
    credentialMissing: "Not paired",
    credentialReadyDetail: "Saved credentials are ready.",
    credentialOneTimeDetail: "This run uses pasted credentials.",
    credentialMissingDetail: "Pair this machine or paste credential text.",
    pairActionDescription: "Get a code and finish setup in the web console.",
    commandActionDescription: "Paste credential text generated in the web console.",
    credentialsTitle: "Connector credentials",
    credentialsDescription: "Saved by pairing or credential setup.",
    clearCredentials: "Clear local credentials",
    clearCredentialsConfirmTitle: "Clear local credentials?",
    clearCredentialsConfirmDescription: "This stops the connector and removes the saved connector config from this computer. It does not delete the connector in Agents Anywhere.",
    clearCredentialsDone: "Local connector credentials cleared",
    serverUrl: "Server URL",
    connectorId: "Connector ID",
    connectorToken: "Connector token",
    syncInterval: "Sync interval",
    syncIntervalDescription: "How often the connector syncs local sessions.",
    saveConfig: "Save config",
    saveAndRestart: "Save and restart",
    savedStarting: "Saved. Starting connector.",
    parseStartCommand: "Paste a server address or credential text.",
    parseMissingValues: "The pasted text is missing required values.",
    parseCredentialPayload: "This credential text is invalid.",
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
    openAgentsAnywhere: "打开 Agents Anywhere",
    headerTitle: "Desktop Connector",
    headerSubtitle: "把这台电脑连接到 Agents Anywhere。",
    runtimeStatus: "连接器",
    pairingStatus: "凭据",
    start: "启动",
    stop: "停止",
    restart: "重启",
    startPairing: "开始配对",
    startFromCommand: "粘贴凭据",
    logs: "日志",
    logsDescription: "最近的连接器活动。",
    liveLogs: "实时",
    pausedLogs: "暂停",
    refresh: "刷新",
    refreshed: "已刷新",
    loadMore: "加载更早日志",
    logRows: "行数",
    logStorageTitle: "日志",
    logChunkSize: "分块大小",
    logRetainChunks: "保留分块",
    logRetentionDays: "保留天数",
    clear: "清空",
    settings: "设置",
    settingsDescription: "启动项和本机连接器选项。",
    startupTitle: "启动",
    appearanceTitle: "外观",
    theme: "主题",
    themeDescription: "选择此桌面应用的颜色主题。",
    systemTheme: "跟随系统",
    lightTheme: "浅色",
    darkTheme: "深色",
    localFilesTitle: "本机文件",
    credentialsSectionTitle: "凭据",
    syncSectionTitle: "同步",
    launchAtLogin: "登录时打开",
    launchAtLoginHint: "登录系统后打开桌面应用。",
    silentLaunch: "登录时静默启动",
    silentLaunchHint: "通过登录项启动时不自动显示窗口，直到从托盘打开或再次启动应用。",
    startOnLaunch: "打开应用后启动连接器",
    startOnLaunchHint: "已保存凭据时自动启动。",
    language: "语言",
    languageDescription: "选择此桌面应用的界面语言。",
    systemLanguage: "跟随系统",
    english: "English",
    simplifiedChinese: "简体中文",
    uvPath: "uv 路径",
    uvResolvedPath: "实际 uv",
    uvResolvedMissing: "未找到",
    uvMissingTitle: "需要安装 uv",
    uvMissingDescription: "桌面连接器需要 uv 来运行本机 Python 连接器。请安装 uv，然后重启桌面应用，或在设置里指定 uv 路径。",
    installUv: "安装 uv",
    uvPypiMirror: "uv PyPI 镜像",
    uvPypiMirrorDescription: "uv 安装或同步 Python 包时使用。",
    pypiDefault: "默认",
    pypiTsinghua: "清华",
    pypiUstc: "中科大",
    pypiBfsu: "北外",
    pypiAliyun: "阿里云",
    pypiTencent: "腾讯云",
    pypiHuawei: "华为云",
    configPath: "配置路径",
    settingsPath: "设置路径",
    logPath: "日志路径",
    openConfigFolder: "打开配置文件夹",
    pairingTitle: "配对这台电脑",
    pairingDescription: "输入服务器地址，也可以粘贴配对请求。",
    pairingComplete: "配对完成",
    pairingCode: "配对码",
    pairingWaiting: "等待在 Web 控制台认领。",
    pairingFailed: "配对失败",
    server: "服务器",
    commandTitle: "粘贴连接器凭据",
    commandDescription: "粘贴 Web 控制台生成的凭据文本。",
    externalLaunchPairTitle: "使用配对请求？",
    externalLaunchStartTitle: "使用连接器凭据？",
    externalLaunchPairDescription: "网页正在请求此桌面应用与下面的服务器开始配对。",
    externalLaunchStartDescription: "网页正在请求此桌面应用保存连接器凭据并启动连接器。",
    externalLaunchOverwriteTitle: "已保存的凭据会被替换",
    externalLaunchOverwriteDescription: "这台电脑已经保存了连接器凭据。继续后，请求成功时会替换本地凭据。",
    externalLaunchConfirmPair: "使用配对请求",
    externalLaunchConfirmStart: "保存并启动",
    externalLaunchInvalid: "不支持的桌面启动链接。",
    commandLabel: "凭据文本",
    pairCommandReady: "配对请求已识别。",
    startCommandReady: "连接器凭据已识别。",
    credentialsPayloadReady: "这段凭据文本可以保存到桌面连接器。",
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
    setupRequired: "需要设置",
    configMissingDetail: "请先配对这台电脑，或粘贴凭据文本，然后再启动连接器。",
    configInvalidDetail: "已保存的连接器配置无效。请清除本地凭据，然后重新配对。",
    connectorSourceMissingDetail: "内置连接器文件缺失或不完整。请重新安装桌面应用。",
    uvMissingDetail: "请安装 uv，或在设置中指定有效的 uv 路径。",
    rpcUnavailableDetail: "连接器运行时不可用。请检查 uv、PyPI 镜像和最近日志。",
    credentialExpired: "凭据已失效",
    fixCredential: "重新配对，或粘贴新的凭据文本。",
    credentialExpiredToast: "凭据已失效。请重新配对，或粘贴新的凭据文本。",
    credentialPaired: "已配对",
    credentialOneTime: "正在使用一次性凭据",
    credentialMissing: "未配对",
    credentialReadyDetail: "已保存凭据。",
    credentialOneTimeDetail: "本次运行使用粘贴的凭据。",
    credentialMissingDetail: "配对这台电脑，或粘贴凭据文本。",
    pairActionDescription: "生成配对码，然后在 Web 控制台完成设置。",
    commandActionDescription: "粘贴 Web 控制台生成的凭据文本。",
    credentialsTitle: "连接器凭据",
    credentialsDescription: "通常由配对或凭据文本保存。",
    clearCredentials: "清除本地凭据",
    clearCredentialsConfirmTitle: "清除本地凭据？",
    clearCredentialsConfirmDescription: "这会停止连接器，并删除这台电脑上保存的连接器配置。不会删除 Agents Anywhere 中的连接器。",
    clearCredentialsDone: "已清除本地连接器凭据",
    serverUrl: "服务器 URL",
    connectorId: "连接器 ID",
    connectorToken: "连接器 token",
    syncInterval: "同步间隔",
    syncIntervalDescription: "连接器同步本机会话的频率。",
    saveConfig: "保存配置",
    saveAndRestart: "保存并重启",
    savedStarting: "已保存，正在启动连接器。",
    parseStartCommand: "请粘贴服务器地址或凭据文本。",
    parseMissingValues: "粘贴的内容缺少必要信息。",
    parseCredentialPayload: "这段凭据无效。",
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

function isConfigBrokenIssue(issue: string | undefined): boolean {
  return issue === "configInvalidJson" || issue === "config:invalid" || issue === "config:incomplete"
}

function setupIssueDetail(state: ConnectorState | null, t: DesktopMessages): string | null {
  const issue = state?.setupIssue || (state?.uvMissing ? "uvMissing" : "")
  if (issue === "uvMissing") return t.uvMissingDetail
  if (issue === "connectorSourceMissing") return t.connectorSourceMissingDetail
  if (issue === "configMissing") return t.configMissingDetail
  if (isConfigBrokenIssue(issue)) return t.configInvalidDetail
  return null
}

function canRunLocalSetup(state: ConnectorState | null): boolean {
  const issue = state?.setupIssue || ""
  return !state?.uvMissing && issue !== "connectorSourceMissing" && !isConfigBrokenIssue(issue)
}

function canStartSavedConnector(state: ConnectorState | null): boolean {
  return Boolean(canRunLocalSetup(state) && state?.hasConfig && !state?.setupIssue)
}

function connectorStatusView(state: ConnectorState | null, isRunning: boolean, t: DesktopMessages): { value: string; detail: string; tone: MetricTone } {
  const setupDetail = setupIssueDetail(state, t)
  const setupIssue = state?.setupIssue || ""
  if (setupDetail && (setupIssue === "uvMissing" || setupIssue === "connectorSourceMissing")) {
    return { value: t.setupRequired, detail: setupDetail, tone: "error" }
  }
  if (state?.lastError && !state.authFailed) {
    return { value: t.runtimeError, detail: setupDetail || state.lastError, tone: "error" }
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
  if (isConfigBrokenIssue(state?.setupIssue)) {
    return { value: t.setupRequired, detail: t.configInvalidDetail, tone: "error" }
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
  const { setTheme } = useTheme()
  const [state, setState] = React.useState<ConnectorState | null>(null)
  const [localeOverride, setLocaleOverride] = React.useState<"system" | "en" | "zh" | null>(null)
  const effectiveLocale = localeOverride ?? state?.locale
  const t = useDesktopMessages(effectiveLocale)
  const [view, setView] = React.useState<View>("overview")
  const [config, setConfig] = React.useState<ConnectorConfig>(defaultConfig)
  const [logs, setLogs] = React.useState<ConnectorLog[]>([])
  const [hasMoreLogsBefore, setHasMoreLogsBefore] = React.useState(false)
  const [logTotal, setLogTotal] = React.useState(0)
  const [logPageSize, setLogPageSize] = React.useState<(typeof LOG_PAGE_SIZE_OPTIONS)[number]>(300)
  const [liveLogs, setLiveLogs] = React.useState(true)
  const [stickToLogBottom, setStickToLogBottom] = React.useState(false)
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
  const [externalLaunchCommand, setExternalLaunchCommand] = React.useState<ExternalLaunchCommand | null>(null)
  const [pendingCredentialAction, setPendingCredentialAction] = React.useState<PendingCredentialAction | null>(null)
  const [uvInstallPromptOpen, setUvInstallPromptOpen] = React.useState(false)
  const authFailedToastShown = React.useRef(false)
  const uvMissingPromptShown = React.useRef(false)
  const savedConfigRef = React.useRef<ConnectorConfig>(defaultConfig)
  const minLogSeqRef = React.useRef<number | null>(null)
  const maxLogSeqRef = React.useRef<number | null>(null)

  const refreshLocalSnapshot = React.useCallback(async () => {
    const api = connectorDesktop()
    const [nextState, nextConfig] = await Promise.all([api.getState(), api.getConfig()])
    setState(nextState)
    const normalizedConfig = { ...defaultConfig, ...nextConfig }
    savedConfigRef.current = normalizedConfig
    setConfig(normalizedConfig)
    setBridgeError(null)
    return nextState
  }, [])

  React.useEffect(() => {
    let cleanup: Array<() => void> = []
    async function boot() {
      try {
        const api = connectorDesktop()
        const drainDeepLinks = async () => {
          const payloads = await api.takeDeepLinks()
          for (const payload of payloads) {
            try {
              const parsed = parseDesktopLaunchUrl(payload.rawUrl, t)
              setExternalLaunchCommand({ ...parsed, rawUrl: payload.rawUrl })
              setPairOpen(false)
              setCommandOpen(false)
            } catch (error) {
              toast.error(error instanceof Error ? error.message : String(error))
            }
          }
        }
        await refreshLocalSnapshot()
        cleanup = [
          api.onState((next) => setState(next)),
          api.onPairing((next) => {
            setPairing(next)
            if (next.status === "waiting") setPairStep("waiting")
            if (next.status === "claimed") setPairStep("claimed")
            if (next.status === "error") setPairStep("error")
            if (next.config) {
              const normalizedConfig = { ...defaultConfig, ...next.config }
              savedConfigRef.current = normalizedConfig
              setConfig(normalizedConfig)
            }
          }),
          api.onDeepLink(() => {
            void drainDeepLinks().catch((error) => {
              toast.error(error instanceof Error ? error.message : String(error))
            })
          }),
          api.onLog(() => undefined),
          api.onLogsCleared(() => {
            setLogs([])
            setHasMoreLogsBefore(false)
            setLogTotal(0)
            updateLogSeqRefs([])
          }),
        ]
        await drainDeepLinks()
      } catch (error) {
        setBridgeError(error instanceof Error ? error.message : String(error))
      }
    }
    void boot()
    return () => {
      for (const dispose of cleanup) dispose()
    }
  }, [refreshLocalSnapshot, t])

  React.useEffect(() => {
    function refreshWhenVisible() {
      if (document.visibilityState === "visible") void refreshLocalSnapshot().catch(() => undefined)
    }
    window.addEventListener("focus", refreshWhenVisible)
    document.addEventListener("visibilitychange", refreshWhenVisible)
    return () => {
      window.removeEventListener("focus", refreshWhenVisible)
      document.removeEventListener("visibilitychange", refreshWhenVisible)
    }
  }, [refreshLocalSnapshot])

  React.useEffect(() => {
    if (view === "logs") {
      void loadLogs({ reset: true, pageSize: logPageSize })
      return
    }
    setLogs([])
    setHasMoreLogsBefore(false)
    setLogTotal(0)
  }, [view, logPageSize])

  React.useEffect(() => {
    if (view !== "logs" || !liveLogs) return
    const id = window.setInterval(() => {
      void syncLatestLogs()
    }, 1000)
    return () => window.clearInterval(id)
  }, [view, liveLogs])

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

  React.useEffect(() => {
    if (state?.appearance === "light" || state?.appearance === "dark" || state?.appearance === "system") {
      setTheme(state.appearance)
    }
  }, [setTheme, state?.appearance])

  React.useEffect(() => {
    if (state?.uvMissing) {
      if (!uvMissingPromptShown.current) {
        uvMissingPromptShown.current = true
        setUvInstallPromptOpen(true)
      }
      return
    }
    uvMissingPromptShown.current = false
  }, [state?.uvMissing])

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

  async function refreshConnectorSnapshot() {
    const next = await run("refreshState", refreshLocalSnapshot)
    if (next) toast.success(t.refreshed)
  }

  function showSetupBlock(): boolean {
    const detail = setupIssueDetail(state, t)
    if (state?.setupIssue === "uvMissing" || state?.uvMissing) {
      setUvInstallPromptOpen(true)
      return true
    }
    if (detail && (state?.setupIssue === "connectorSourceMissing" || isConfigBrokenIssue(state?.setupIssue))) {
      toast.error(detail)
      return true
    }
    return false
  }

  async function startConnector(runtimeConfig?: ConnectorConfig): Promise<boolean> {
    if (!runtimeConfig && !canStartSavedConnector(state)) {
      if (!showSetupBlock()) toast.error(t.configMissingDetail)
      return false
    }
    if (runtimeConfig && !canRunLocalSetup(state)) {
      showSetupBlock()
      return false
    }
    const next = await run("start", () => connectorDesktop().start(runtimeConfig), t.connectorStarted)
    if (!next) return false
    setState(next)
    return true
  }

  async function stopConnector() {
    const next = await run("stop", () => connectorDesktop().stop(), t.connectorStopped)
    if (next) setState(next)
  }

  async function restartConnector() {
    if (!canStartSavedConnector(state)) {
      if (!showSetupBlock()) toast.error(t.configMissingDetail)
      return
    }
    const next = await run("restart", () => connectorDesktop().restart(), t.connectorRestarted)
    if (next) setState(next)
  }

  async function startOrRestartSavedConnector(): Promise<boolean> {
    if (state?.running) {
      const next = await run("restart", () => connectorDesktop().restart(), t.connectorRestarted)
      if (!next) return false
      setState(next)
      return true
    }
    const next = await run("start", () => connectorDesktop().start(), t.connectorStarted)
    if (!next) return false
    setState(next)
    return true
  }

  async function saveConfig(nextConfig: ConnectorConfig) {
    const saved = await run("save", () => connectorDesktop().saveConfig(nextConfig), t.configSaved)
    if (saved) {
      const normalizedConfig = { ...defaultConfig, ...saved }
      savedConfigRef.current = normalizedConfig
      setConfig(normalizedConfig)
    }
    return saved
  }

  function hasSavedConnectorCredentials(): boolean {
    const savedConfig = savedConfigRef.current
    return Boolean(state?.hasConfig || savedConfig.connectorId || savedConfig.connectorToken)
  }

  function credentialIdentityChanged(nextConfig: ConnectorConfig): boolean {
    if (!hasSavedConnectorCredentials()) return false
    const savedConfig = savedConfigRef.current
    return (
      (nextConfig.serverUrl || "") !== (savedConfig.serverUrl || "") ||
      (nextConfig.connectorId || "") !== (savedConfig.connectorId || "") ||
      (nextConfig.connectorToken || "") !== (savedConfig.connectorToken || "")
    )
  }

  function hasCompleteConnectorConfig(nextConfig: ConnectorConfig): boolean {
    return Boolean(nextConfig.serverUrl && nextConfig.connectorId && nextConfig.connectorToken)
  }

  function shouldConfirmCredentialAction(action: PendingCredentialAction): boolean {
    if (action.source === "external") return true
    if (action.kind === "pair") return hasSavedConnectorCredentials()
    return credentialIdentityChanged(action.config)
  }

  function requestCredentialAction(action: PendingCredentialAction) {
    if (shouldConfirmCredentialAction(action)) {
      setPendingCredentialAction(action)
      return
    }
    void executeCredentialAction(action)
  }

  async function executeCredentialAction(action: PendingCredentialAction): Promise<boolean> {
    if (!canRunLocalSetup(state)) {
      showSetupBlock()
      return false
    }
    if (action.kind === "pair") {
      setPairServer(action.server)
      const started = await beginPairing(action.server)
      if (!started) return false
      setCommandOpen(false)
      setExternalLaunchCommand(null)
      setPendingCredentialAction(null)
      setPairOpen(true)
      return true
    }
    const writesCredentialIdentity = hasCompleteConnectorConfig(action.config) && (!hasSavedConnectorCredentials() || credentialIdentityChanged(action.config))
    const shouldActivateSavedConfig = action.kind === "start" || action.restart || writesCredentialIdentity
    const saved = await saveConfig(action.config)
    if (!saved) return false
    if (action.kind === "save") {
      if (shouldActivateSavedConfig) {
        const activated = await startOrRestartSavedConnector()
        if (!activated) return false
      }
      setPendingCredentialAction(null)
      return true
    }
    const activated = await startOrRestartSavedConnector()
    if (!activated) return false
    setCommandOpen(false)
    setExternalLaunchCommand(null)
    setPendingCredentialAction(null)
    return true
  }

  function requestSaveConfig(nextConfig: ConnectorConfig, restart = false) {
    requestCredentialAction({ kind: "save", config: nextConfig, restart, source: "settings" })
  }

  async function clearCredentials() {
    const next = await run("clearCredentials", () => connectorDesktop().clearCredentials(), t.clearCredentialsDone)
    if (!next) return
    setState(next)
    savedConfigRef.current = defaultConfig
    setConfig(defaultConfig)
  }

  async function loadLogs(options: { reset?: boolean; pageSize?: number } = {}) {
    const pageSize = options.pageSize ?? logPageSize
    const page = await run("logs", () => connectorDesktop().getLogs({ pageSize }))
    if (!page) return
    setLogs(page.items)
    updateLogSeqRefs(page.items)
    setHasMoreLogsBefore(page.hasMoreBefore)
    setLogTotal(page.total)
    if (options.reset) setStickToLogBottom(true)
  }

  async function loadEarlierLogs() {
    const beforeSeq = minLogSeqRef.current
    if (beforeSeq == null) return
    const page = await run("logs", () => connectorDesktop().getLogs({ beforeSeq, pageSize: logPageSize }))
    if (!page || page.items.length === 0) return
    setLogs((current) => {
      const next = mergeLogsBySeq(page.items, current)
      updateLogSeqRefs(next)
      return next
    })
    setHasMoreLogsBefore(page.hasMoreBefore)
    setLogTotal(page.total)
  }

  async function syncLatestLogs() {
    const afterSeq = maxLogSeqRef.current
    if (afterSeq == null) {
      await loadLogs({ reset: true, pageSize: logPageSize })
      return
    }
    let page
    try {
      page = await connectorDesktop().getLogs({ afterSeq, pageSize: logPageSize })
    } catch {
      setLiveLogs(false)
      return
    }
    if (page.items.length === 0) {
      setLogTotal(page.total)
      return
    }
    setLogs((current) => {
      const next = mergeLogsBySeq(current, page.items)
      updateLogSeqRefs(next)
      return next
    })
    setHasMoreLogsBefore((current) => current || page.hasMoreBefore)
    setLogTotal(page.total)
    setStickToLogBottom(true)
  }

  async function clearLogs() {
    const page = await run("clearLogs", () => connectorDesktop().clearLogs())
    if (!page) return
    setLogs(page.items)
    updateLogSeqRefs(page.items)
    setHasMoreLogsBefore(page.hasMoreBefore)
    setLogTotal(page.total)
  }

  function updateLogSeqRefs(items: ConnectorLog[]) {
    const seqs = items.map((item) => item.seq).filter((seq): seq is number => typeof seq === "number")
    minLogSeqRef.current = seqs.length ? Math.min(...seqs) : null
    maxLogSeqRef.current = seqs.length ? Math.max(...seqs) : null
  }

  function mergeLogsBySeq(...groups: ConnectorLog[][]) {
    const map = new Map<number, ConnectorLog>()
    const withoutSeq: ConnectorLog[] = []
    for (const group of groups) {
      for (const item of group) {
        if (typeof item.seq === "number") map.set(item.seq, item)
        else withoutSeq.push(item)
      }
    }
    return [...withoutSeq, ...Array.from(map.values()).sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))]
  }

  async function beginPairing(server: string) {
    const next = await run("pairing", () => connectorDesktop().startPairing({ server }), t.pairingStarted)
    if (!next) return false
    setPairing(next)
    setPairStep(next.status === "waiting" ? "waiting" : "input")
    return true
  }

  async function startPairing() {
    if (!canRunLocalSetup(state)) {
      showSetupBlock()
      return
    }
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
    requestCredentialAction({ kind: "pair", server, source: "manual" })
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

  function saveAppearance(appearance: AppearanceMode) {
    setTheme(appearance)
    void saveSettings({ appearance })
  }

  async function openAgentsAnywhere() {
    const serverUrl = state?.serverUrl || config.serverUrl
    if (!serverUrl) return
    await run("openServer", () => connectorDesktop().openServer(serverUrl))
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
    if (!canRunLocalSetup(state)) {
      showSetupBlock()
      return
    }
    if (parsedCommand.kind === "pair") {
      setPairStep("input")
      requestCredentialAction({ kind: "pair", server: parsedCommand.server, source: "command" })
      return
    }
    if (save) {
      requestCredentialAction({ kind: "start", config: parsedCommand.config, source: "command" })
    } else {
      await startConnector(parsedCommand.config)
    }
    setCommandOpen(false)
  }

  async function confirmExternalLaunch() {
    if (!externalLaunchCommand) return
    if (!canRunLocalSetup(state)) {
      showSetupBlock()
      return
    }
    if (externalLaunchCommand.kind === "pair") {
      await executeCredentialAction({ kind: "pair", server: externalLaunchCommand.server, source: "external" })
      return
    }
    await executeCredentialAction({ kind: "start", config: externalLaunchCommand.config, source: "external" })
  }

  const isRunning = Boolean(state?.running)
  const connectorView = connectorStatusView(state, isRunning, t)
  const credentialView = credentialStatusView(state, config, isRunning, t)
  const setupDetail = setupIssueDetail(state, t)
  const savedCredentialServer = state?.serverUrl || savedConfigRef.current.serverUrl
  const hasSavedCredentials = hasSavedConnectorCredentials()
  const showSetupNotice = Boolean(setupDetail && state?.setupIssue !== "configMissing")
  const startSavedEnabled = canStartSavedConnector(state)
  const setupActionsEnabled = canRunLocalSetup(state)
  const isMac = state?.platform === "darwin"
  const serverUrl = state?.serverUrl || config.serverUrl
  const canOpenServer = isRunning && Boolean(serverUrl)
  const pageTitle = view === "logs" ? t.logs : view === "settings" ? t.settings : t.navOverview
  const pageDescription = view === "logs" ? t.logsDescription : view === "settings" ? t.settingsDescription : t.headerSubtitle

  return (
    <div className="flex h-screen min-h-0 bg-background text-foreground">
      <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className={cn("drag-region flex px-5", isMac ? "h-20 items-end pb-4" : "h-16 items-center")}>
          <div className="min-w-0">
            <div className="aa-wordmark text-xl">{t.appName}</div>
          </div>
        </div>
        <nav className="no-drag flex flex-1 flex-col gap-1 px-3 py-2 text-sm">
          <NavItem icon={Gauge} label={t.navOverview} active={view === "overview"} onClick={() => setView("overview")} />
          <NavItem icon={Logs} label={t.navLogs} active={view === "logs"} onClick={() => setView("logs")} />
        </nav>
        <div className="no-drag flex flex-col gap-1 p-3">
          <div className="px-3 pb-2">
            <StatusPill label={connectorView.value} tone={connectorView.tone} />
          </div>
          <Button
            type="button"
            variant="ghost"
            className="h-9 justify-start rounded-md px-3 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            disabled={!canOpenServer}
            onClick={() => void openAgentsAnywhere()}
          >
            <ExternalLink className="size-4" />
            {t.openAgentsAnywhere}
          </Button>
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
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="min-w-24 justify-between">
                      {logPageSize}
                      <ChevronDown className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-36">
                    <DropdownMenuRadioGroup
                      value={String(logPageSize)}
                      onValueChange={(next) => setLogPageSize(Number(next) as (typeof LOG_PAGE_SIZE_OPTIONS)[number])}
                    >
                      {LOG_PAGE_SIZE_OPTIONS.map((count) => (
                        <DropdownMenuRadioItem key={count} value={String(count)}>
                          {count} {t.logRows}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button variant="outline" size="sm" onClick={() => void loadLogs({ reset: true, pageSize: logPageSize })} disabled={Boolean(busy)}>
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
                <Button variant="outline" size="sm" onClick={() => void refreshConnectorSnapshot()} disabled={Boolean(busy)}>
                  <RefreshCw className={cn("size-4", busy === "refreshState" && "animate-spin")} />
                  {t.refresh}
                </Button>
                <Button variant="outline" size="sm" onClick={restartConnector} disabled={Boolean(busy) || !startSavedEnabled}>
                  <RotateCcw className="size-4" />
                  {t.restart}
                </Button>
                {isRunning ? (
                  <Button variant="destructive" size="sm" onClick={stopConnector} disabled={Boolean(busy)}>
                    <Square className="size-4" />
                    {t.stop}
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => startConnector()} disabled={Boolean(busy) || !startSavedEnabled}>
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
            {showSetupNotice ? (
              <SetupNotice
                t={t}
                detail={setupDetail || t.rpcUnavailableDetail}
                issue={state?.setupIssue || ""}
                onInstallUv={() => setUvInstallPromptOpen(true)}
                onClearCredentials={() => void clearCredentials()}
              />
            ) : null}
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
                setupActionsEnabled={setupActionsEnabled}
                onSetupBlocked={showSetupBlock}
              />
            ) : null}
            {view === "logs" ? (
              <LogsView
                t={t}
                logs={logs}
                total={logTotal}
                hasMore={hasMoreLogsBefore}
                stickToBottom={stickToLogBottom}
                onStickHandled={() => setStickToLogBottom(false)}
                onLoadMore={() => void loadEarlierLogs()}
              />
            ) : null}
            {view === "settings" ? (
              <SettingsView
                t={t}
                state={state}
                config={config}
                locale={effectiveLocale}
                setConfig={setConfig}
                saveConfig={requestSaveConfig}
                isRunning={isRunning}
                busy={busy}
                clearCredentials={clearCredentials}
                saveSettings={saveSettings}
                saveLocale={saveLocale}
                saveAppearance={saveAppearance}
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
        connectorRunning={isRunning}
        onCommandChange={setCommandInput}
        onOpenChange={setCommandOpen}
        onParse={parseCommand}
        onRun={runParsedCommand}
      />
      <ExternalLaunchDialog
        t={t}
        command={externalLaunchCommand}
        busy={busy}
        connectorRunning={isRunning}
        hasSavedCredentials={hasSavedCredentials}
        savedCredentialServer={savedCredentialServer}
        onOpenChange={(open) => {
          if (!open && !busy) setExternalLaunchCommand(null)
        }}
        onConfirm={confirmExternalLaunch}
      />
      <CredentialOverwriteDialog
        t={t}
        action={pendingCredentialAction}
        busy={busy}
        connectorRunning={isRunning}
        savedCredentialServer={savedCredentialServer}
        onOpenChange={(open) => {
          if (!open && !busy) setPendingCredentialAction(null)
        }}
        onConfirm={async () => {
          if (pendingCredentialAction) await executeCredentialAction(pendingCredentialAction)
        }}
      />
      <AlertDialog open={uvInstallPromptOpen} onOpenChange={setUvInstallPromptOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.uvMissingTitle}</AlertDialogTitle>
            <AlertDialogDescription>{t.uvMissingDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void connectorDesktop().openUvInstall()}>
              {t.installUv}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  setupActionsEnabled,
  onSetupBlocked,
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
  setupActionsEnabled: boolean
  onSetupBlocked: () => boolean
}) {
  function runIfReady(action: () => void) {
    if (!setupActionsEnabled) {
      onSetupBlocked()
      return
    }
    action()
  }

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
          onClick={() => runIfReady(onPair)}
        />
        <ActionCard
          icon={Clipboard}
          title={t.startFromCommand}
          description={t.commandActionDescription}
          onClick={() => runIfReady(onCommand)}
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
  isRunning,
  busy,
  clearCredentials,
  saveSettings,
  saveLocale,
  saveAppearance,
}: {
  t: DesktopMessages
  state: ConnectorState | null
  config: ConnectorConfig
  locale: string | undefined
  setConfig: React.Dispatch<React.SetStateAction<ConnectorConfig>>
  saveConfig: (config: ConnectorConfig, restart?: boolean) => void
  isRunning: boolean
  busy: string | null
  clearCredentials: () => Promise<void>
  saveSettings: (settings: DesktopSettings) => Promise<void>
  saveLocale: (locale: "system" | "en" | "zh") => void
  saveAppearance: (appearance: AppearanceMode) => void
}) {
  const [uvPath, setUvPath] = React.useState(state?.uvPath || "")
  const hasCredential = Boolean(state?.hasConfig || config.connectorId || config.connectorToken || config.serverUrl)

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
              label={t.silentLaunch}
              description={t.silentLaunchHint}
              checked={Boolean(state?.silentLaunch)}
              onCheckedChange={(silentLaunch) => saveSettings({ silentLaunch })}
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
            <InfoRow label={t.uvResolvedPath} value={<ScrollableCode value={state?.resolvedUvPath || t.uvResolvedMissing} />} />
            <PypiMirrorField
              t={t}
              value={state?.uvPypiIndexUrl || ""}
              onValueChange={(uvPypiIndexUrl) => saveSettings({ uvPypiIndexUrl })}
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
          <CardTitle>{t.syncSectionTitle}</CardTitle>
          <CardAction>
            <RefreshCw className="size-5" />
          </CardAction>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <SyncIntervalField
              t={t}
              value={Number(config.syncIntervalSeconds ?? 30)}
              onValueChange={(syncIntervalSeconds) => setConfig((current) => ({ ...current, syncIntervalSeconds }))}
            />
            <div className="flex justify-end gap-2">
              <Button onClick={() => saveConfig(config)}>
                <CheckCircle2 className="size-4" />
                {t.saveConfig}
              </Button>
              <Button
                variant="outline"
                disabled={!isRunning}
                onClick={() => saveConfig(config, true)}
              >
                <RotateCcw className="size-4" />
                {t.saveAndRestart}
              </Button>
            </div>
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
            <AppearanceField
              t={t}
              value={(state?.appearance === "light" || state?.appearance === "dark" || state?.appearance === "system") ? state.appearance : "system"}
              onValueChange={saveAppearance}
            />
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
            <div className="flex justify-end gap-2">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" disabled={Boolean(busy) || !hasCredential}>
                    <Trash2 className="size-4" />
                    {t.clearCredentials}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t.clearCredentialsConfirmTitle}</AlertDialogTitle>
                    <AlertDialogDescription>{t.clearCredentialsConfirmDescription}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t.cancel}</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => void clearCredentials()}>
                      {t.clearCredentials}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Button onClick={() => saveConfig(config)}>
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
                placeholder="https://example.com"
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

function ExternalLaunchDialog({
  t,
  command,
  busy,
  connectorRunning,
  hasSavedCredentials,
  savedCredentialServer,
  onOpenChange,
  onConfirm,
}: {
  t: DesktopMessages
  command: ExternalLaunchCommand | null
  busy: string | null
  connectorRunning: boolean
  hasSavedCredentials: boolean
  savedCredentialServer: string
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void>
}) {
  const isStart = command?.kind === "start"
  const server = command?.kind === "start" ? command.config.serverUrl : command?.server
  const loading = Boolean(busy)

  return (
    <AlertDialog open={Boolean(command)} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{isStart ? t.externalLaunchStartTitle : t.externalLaunchPairTitle}</AlertDialogTitle>
          <AlertDialogDescription>
            {isStart ? t.externalLaunchStartDescription : t.externalLaunchPairDescription}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-3 text-sm">
          {server ? (
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="text-xs font-medium uppercase text-muted-foreground">{t.server}</div>
              <div className="mt-1 break-all font-mono text-xs">{server}</div>
            </div>
          ) : null}
          {hasSavedCredentials ? (
            <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-3">
              <div className="flex items-center gap-2 font-medium text-destructive">
                <CircleAlert className="size-4" />
                {t.externalLaunchOverwriteTitle}
              </div>
              <p className="mt-1 text-muted-foreground">{t.externalLaunchOverwriteDescription}</p>
              {savedCredentialServer ? (
                <div className="mt-2 break-all font-mono text-xs text-muted-foreground">{savedCredentialServer}</div>
              ) : null}
            </div>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>{t.cancel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault()
              void onConfirm()
            }}
            disabled={loading}
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : isStart ? <Play className="size-4" /> : <Plus className="size-4" />}
            {isStart ? (connectorRunning ? t.saveAndRestart : t.externalLaunchConfirmStart) : t.externalLaunchConfirmPair}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function CredentialOverwriteDialog({
  t,
  action,
  busy,
  connectorRunning,
  savedCredentialServer,
  onOpenChange,
  onConfirm,
}: {
  t: DesktopMessages
  action: PendingCredentialAction | null
  busy: string | null
  connectorRunning: boolean
  savedCredentialServer: string
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void>
}) {
  const server = action?.kind === "pair" ? action.server : action?.config.serverUrl
  const loading = Boolean(busy)
  const confirmLabel = action?.kind === "pair" ? t.externalLaunchConfirmPair : action?.kind === "save" ? (action.restart || connectorRunning ? t.saveAndRestart : t.saveConfig) : (connectorRunning ? t.saveAndRestart : t.externalLaunchConfirmStart)

  return (
    <AlertDialog open={Boolean(action)} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t.externalLaunchOverwriteTitle}</AlertDialogTitle>
          <AlertDialogDescription>{t.externalLaunchOverwriteDescription}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-3 text-sm">
          {server ? (
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="text-xs font-medium uppercase text-muted-foreground">{t.server}</div>
              <div className="mt-1 break-all font-mono text-xs">{server}</div>
            </div>
          ) : null}
          {savedCredentialServer ? (
            <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-3">
              <div className="flex items-center gap-2 font-medium text-destructive">
                <CircleAlert className="size-4" />
                {t.externalLaunchOverwriteTitle}
              </div>
              <div className="mt-2 break-all font-mono text-xs text-muted-foreground">{savedCredentialServer}</div>
            </div>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>{t.cancel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault()
              void onConfirm()
            }}
            disabled={loading}
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : action?.kind === "pair" ? <Plus className="size-4" /> : <Play className="size-4" />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function CommandDialog({
  t,
  open,
  step,
  command,
  parsed,
  busy,
  connectorRunning,
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
  connectorRunning: boolean
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
                placeholder={t.commandDescription}
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
              <div className="font-medium">
                {parsed?.kind === "pair" ? t.pairCommandReady : parsed?.source === "payload" ? t.credentialsPayloadReady : t.startCommandReady}
              </div>
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
                    {connectorRunning ? t.saveAndRestart : t.saveAndStart}
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

function StatusPill({ label, tone }: { label: string; tone: MetricTone }) {
  return (
    <div
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-xs font-medium",
        tone === "success" && "bg-emerald-500/15 text-emerald-500",
        tone === "error" && "bg-destructive/15 text-destructive",
        tone === "default" && "bg-muted text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "success" && "bg-emerald-500",
          tone === "error" && "bg-destructive",
          tone === "default" && "bg-muted-foreground",
        )}
      />
      {label}
    </div>
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
        <CardTitle className={cn("text-xl", tone === "error" && "text-destructive", tone === "success" && "text-emerald-500")}>{value}</CardTitle>
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
  stickToBottom,
  onStickHandled,
  onLoadMore,
}: {
  t: DesktopMessages
  logs: ConnectorLog[]
  total: number
  hasMore: boolean
  stickToBottom: boolean
  onStickHandled: () => void
  onLoadMore: () => void
}) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null)
  const loadingMoreRef = React.useRef(false)

  React.useEffect(() => {
    if (!stickToBottom) return
    const viewport = viewportRef.current
    if (!viewport) return
    requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight
      onStickHandled()
    })
  }, [logs, stickToBottom, onStickHandled])

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    if (!hasMore || loadingMoreRef.current) return
    if (event.currentTarget.scrollTop > 24) return
    loadingMoreRef.current = true
    onLoadMore()
    window.setTimeout(() => {
      loadingMoreRef.current = false
    }, 500)
  }

  if (logs.length === 0) {
    return <div className="flex h-[calc(100vh-4rem)] items-center justify-center text-sm text-muted-foreground">{t.noLogs}</div>
  }
  return (
    <div className="flex h-[calc(100vh-4rem)] min-h-0 flex-col">
      <div className="border-b px-5 py-2 text-xs text-muted-foreground">
        {logs.length} / {total}
      </div>
      <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef} viewportProps={{ onScroll: handleScroll }}>
        <div className="px-5 py-3 font-mono text-xs">
          {hasMore ? (
            <div className="flex justify-center pb-3">
              <Button variant="outline" size="sm" onClick={onLoadMore}>
                {t.loadMore}
              </Button>
            </div>
          ) : null}
          {logs.map((log, index) => (
            <div key={`${log.time || index}-${index}`} className="grid grid-cols-[88px_72px_1fr] gap-2 py-0.5">
              <span className="text-muted-foreground">{log.time ? new Date(log.time).toLocaleTimeString() : "--:--:--"}</span>
              <span className={cn("text-muted-foreground", log.level === "ERROR" && "text-destructive", log.level === "WARNING" && "text-yellow-600")}>{log.level || "INFO"}</span>
              <span className="min-w-0 break-words">{logMessage(log)}</span>
            </div>
          ))}
        </div>
      </ScrollArea>
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

function AppearanceField({
  t,
  value,
  onValueChange,
}: {
  t: DesktopMessages
  value: AppearanceMode
  onValueChange: (value: AppearanceMode) => void
}) {
  const current = APPEARANCE_OPTIONS.find((theme) => theme.id === value) ?? APPEARANCE_OPTIONS[0]
  const CurrentIcon = current.icon

  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldTitle>{t.theme}</FieldTitle>
        <FieldDescription>{t.themeDescription}</FieldDescription>
      </FieldContent>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" className="min-w-40 justify-between">
            <CurrentIcon data-icon="inline-start" />
            {t[current.messageKey]}
            <ChevronDown data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuRadioGroup value={value} onValueChange={(next) => onValueChange(next as AppearanceMode)}>
            {APPEARANCE_OPTIONS.map((theme) => {
              const Icon = theme.icon
              return (
                <DropdownMenuRadioItem key={theme.id} value={theme.id}>
                  <Icon data-icon="inline-start" />
                  {t[theme.messageKey]}
                </DropdownMenuRadioItem>
              )
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </Field>
  )
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

function SyncIntervalField({
  t,
  value,
  onValueChange,
}: {
  t: DesktopMessages
  value: number
  onValueChange: (value: number) => void
}) {
  const normalized = SYNC_INTERVAL_OPTIONS.includes(value as (typeof SYNC_INTERVAL_OPTIONS)[number]) ? value : 30

  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldTitle>{t.syncInterval}</FieldTitle>
        <FieldDescription>{t.syncIntervalDescription}</FieldDescription>
      </FieldContent>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" className="min-w-32 justify-between">
            {normalized}s
            <ChevronDown data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuRadioGroup value={String(normalized)} onValueChange={(next) => onValueChange(Number(next))}>
            {SYNC_INTERVAL_OPTIONS.map((interval) => (
              <DropdownMenuRadioItem key={interval} value={String(interval)}>
                {interval}s
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </Field>
  )
}

function PypiMirrorField({
  t,
  value,
  onValueChange,
}: {
  t: DesktopMessages
  value: string
  onValueChange: (value: string) => void
}) {
  const defaultOption = PYPI_MIRROR_OPTIONS[0]!
  const current = PYPI_MIRROR_OPTIONS.find((option) => option.url === value) ?? defaultOption
  const label = pypiMirrorLabel(t, current.id)

  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldTitle>{t.uvPypiMirror}</FieldTitle>
        <FieldDescription>{t.uvPypiMirrorDescription}</FieldDescription>
      </FieldContent>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" className="min-w-44 justify-between">
            {label}
            <ChevronDown data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuRadioGroup value={current.url} onValueChange={onValueChange}>
            {PYPI_MIRROR_OPTIONS.map((option) => (
              <DropdownMenuRadioItem key={option.id} value={option.url}>
                <span>{pypiMirrorLabel(t, option.id)}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </Field>
  )
}

function pypiMirrorLabel(t: DesktopMessages, id: string): string {
  if (id === "tsinghua") return t.pypiTsinghua
  if (id === "ustc") return t.pypiUstc
  if (id === "bfsu") return t.pypiBfsu
  if (id === "aliyun") return t.pypiAliyun
  if (id === "tencent") return t.pypiTencent
  if (id === "huawei") return t.pypiHuawei
  return t.pypiDefault
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
    <div className="flex items-center gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-sm">
      <CheckCircle2 className="size-4 text-emerald-500" />
      {t.savedStarting}
    </div>
  )
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/25 bg-card px-3 py-2 text-sm">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      <span className="text-muted-foreground">{message}</span>
    </div>
  )
}

function BridgeError({ t, message }: { t: DesktopMessages; message: string }) {
  return (
    <Card className="border-destructive/25">
      <CardHeader className="gap-2">
        <div className="flex items-center gap-2">
          <CircleAlert className="size-4 text-destructive" />
          <CardTitle className="text-base">{t.bridgeUnavailable}</CardTitle>
        </div>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
    </Card>
  )
}

function SetupNotice({
  t,
  detail,
  issue,
  onInstallUv,
  onClearCredentials,
}: {
  t: DesktopMessages
  detail: string
  issue: string
  onInstallUv: () => void
  onClearCredentials: () => void
}) {
  return (
    <Card className="border-destructive/25">
      <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CircleAlert className="size-4 text-destructive" />
            <CardTitle className="text-base">{t.setupRequired}</CardTitle>
          </div>
          <CardDescription className="mt-1">{detail}</CardDescription>
        </div>
        {issue === "uvMissing" ? (
          <Button size="sm" variant="outline" onClick={onInstallUv}>
            {t.installUv}
          </Button>
        ) : null}
        {isConfigBrokenIssue(issue) ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline">
                <Trash2 className="size-4" />
                {t.clearCredentials}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t.clearCredentialsConfirmTitle}</AlertDialogTitle>
                <AlertDialogDescription>{t.clearCredentialsConfirmDescription}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t.cancel}</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={onClearCredentials}>
                  {t.clearCredentials}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </CardHeader>
    </Card>
  )
}

function parseDesktopLaunchUrl(rawUrl: string, t: DesktopMessages): ParsedConnectorCommand {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(t.externalLaunchInvalid)
  }
  if (url.protocol !== "agents-anywhere:") throw new Error(t.externalLaunchInvalid)
  const action = (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase()
  if (action === "start") {
    const serverUrl = (url.searchParams.get("serverUrl") || url.searchParams.get("server") || "").trim().replace(/\/+$/, "")
    const connectorId = (url.searchParams.get("connectorId") || url.searchParams.get("id") || "").trim()
    const connectorToken = (url.searchParams.get("connectorToken") || url.searchParams.get("token") || "").trim()
    if (!/^https?:\/\//i.test(serverUrl) || !connectorId || !connectorToken) {
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
  if (action === "pair" || action === "login") {
    const server = (url.searchParams.get("serverUrl") || url.searchParams.get("server") || "").trim().replace(/\/+$/, "")
    if (!/^https?:\/\//i.test(server)) throw new Error(t.parseMissingValues)
    return { kind: "pair", server }
  }
  throw new Error(t.externalLaunchInvalid)
}

function parseConnectorCommand(input: string, t: DesktopMessages): ParsedConnectorCommand {
  const text = input.trim()
  if (!text) throw new Error(t.parseStartCommand)
  const payloadConfig = parseConnectorCredentialsPayload(text)
  if (payloadConfig === "invalid") throw new Error(t.parseCredentialPayload)
  if (payloadConfig) return { kind: "start", config: payloadConfig, source: "payload" }
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
    source: "command",
    config: {
      ...defaultConfig,
      serverUrl,
      connectorId,
      connectorToken,
    },
  }
}

function parseConnectorCredentialsPayload(input: string): ConnectorConfig | "invalid" | null {
  const compact = input.replace(/\s/g, "")
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null
  try {
    const binary = atob(compact)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
      type?: unknown
      version?: unknown
      serverUrl?: unknown
      connectorId?: unknown
      connectorToken?: unknown
    }
    const serverUrl = typeof payload.serverUrl === "string" ? payload.serverUrl.trim().replace(/\/+$/, "") : ""
    const connectorId = typeof payload.connectorId === "string" ? payload.connectorId.trim() : ""
    const connectorToken = typeof payload.connectorToken === "string" ? payload.connectorToken.trim() : ""
    if (
      payload.type !== "agents-anywhere.connector-credentials" ||
      payload.version !== 1 ||
      !/^https?:\/\//i.test(serverUrl) ||
      !connectorId ||
      !connectorToken
    ) {
      return payload.type === "agents-anywhere.connector-credentials" ? "invalid" : null
    }
    return {
      ...defaultConfig,
      serverUrl,
      connectorId,
      connectorToken,
    }
  } catch {
    return null
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
